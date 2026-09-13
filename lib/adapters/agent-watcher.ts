// 多源 agent 会话感知（2026-09-11 扩展：原感知层只看 Claude Code，实战中等于没输入）
//
// 背景（本机实测）：~/.claude/projects 只有一个 7 月后不再更新的 jsonl，Codex 同样停在 7/31；
// 真正在用的是 DSH（~/.dsh/sessions/**，几百个会话目录、正在实时写）与 OpenCode
// （~/.local/share/opencode/opencode.db，266 个会话）→ 只监听 Claude Code 时感知层永远静默。
//
// 四源统一归一为 agent:* 事件（**只读元数据，不落正文**；与 lib/events.ts 的统一事件模型对齐）：
//   agent:session_started {sessionId, label, dir}
//   agent:tool_use        {tool}
//   agent:assistant_reply {replyLen}
//   agent:session_finished{sessionId, label, durationSec, toolCount}
// 各源的"元数据"如何取：
//   claude-code  ~/.claude/projects/**/*.jsonl         行增量（委托 createCcWatcher）
//   codex        ~/.codex/sessions/**/rollout-*.jsonl  行增量：task_started/agent_message/function_call/task_complete
//   dsh          ~/.dsh/sessions/**/session.jsonl.zstd **zstd 多帧追加流**：只解尾部若干帧，按 seq0 单调去重
//   opencode     ~/.local/share/opencode/opencode.db   SQLite 只读按 rowid 轮询（库可能 1GB+，不能全表扫）
// 通用刹车：idleTimeoutMs 无增长且**本进程内见过增长**才判 session_finished（避免把静止的历史会话
// 误报成"刚结束"——旧 cc-watcher 的 128 条假审计记录就是这么来的）。
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import os from "node:os";

import { createCcWatcher, defaultCcDir } from "./cc-watcher.mjs";
import type { UnifiedEvent } from "../events.mjs";

/** 默认端口/目录（全部可用参数覆盖，测试注入临时目录） */
export const defaultCodexDir = () => path.join(os.homedir(), ".codex", "sessions");
export const defaultDshDir = () => path.join(os.homedir(), ".dsh", "sessions");
export const defaultOpenCodeDb = () => path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

/**
 * 归一化后的 agent 会话事件——直接复用 lib/events.ts 的统一事件模型（{type, source, ts, payload}），
 * 不再本地重复声明一份同形类型（多源适配器与总线同一把尺）
 */
export type AgentEvent = UnifiedEvent;
export type AgentEmit = (ev: AgentEvent) => void;

/**
 * 各源工厂的公共选项（emit 显式声明类型——默认值 `() => {}` 若靠推断会变成"零参函数"，
 * 调用 emit(ev) 会报 TS2554；由 SourceOpts 上下文定型后默认值自动获得正确签名）
 */
export interface SourceOpts {
  emit?: AgentEmit;
  idleTimeoutMs?: number;
  now?: () => number;
}

/** 解析出的单条归一化事件（seq/ts 仅部分源有） */
export interface ParsedEvent {
  type: string;
  payload: Record<string, unknown>;
  seq?: number;
  ts?: number;
}

/** 统一源接口（createAgentWatcher 聚合用） */
export interface WatcherSource {
  name: string;
  tick: () => number;
  close?: () => void;
  files?: () => number;
  state?: () => Record<string, unknown>;
}

// ---------- 通用：目录递归列文件 ----------
/** 跨平台取路径最后一段：会话文件里的 cwd/directory 可能来自另一平台风格，
 *  `path.basename` 在 Linux 上不认反斜杠（CI 实测：D:\proj 会整串返回）→ 两种分隔符都切 */
const baseName = (p: unknown): string => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";

function listFiles(dir: string, match: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (match(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

// ============================================================
// Codex：rollout jsonl（事件元数据齐全，含 task_started/task_complete）
// ============================================================
/**
 * 解析一行 Codex rollout，返回归一化事件或 null
 */
export function parseCodexLine(line: string): ParsedEvent | null {
  if (!line || !line.trim()) return null;
  let j: any;
  try { j = JSON.parse(line); } catch { return null; }
  const t = j?.type;
  const p = j?.payload || {};
  if (t === "session_meta") return { type: "meta", payload: { sessionId: String(p.id || p.session_id || ""), cwd: String(p.cwd || "") } };
  if (t === "event_msg") {
    if (p.type === "task_started") return { type: "started", payload: {} };
    if (p.type === "task_complete") return { type: "finished", payload: {} };
    if (p.type === "agent_message") {
      const len = String(p.message || "").length;
      return len ? { type: "assistant_reply", payload: { replyLen: len } } : null;
    }
    return null;
  }
  if (t === "response_item") {
    if (p.type === "message" && p.role === "assistant") {
      const len = Array.isArray(p.content)
        ? p.content.reduce((n: number, c: any) => n + String(c?.text || "").length, 0)
        : String(p.content || "").length;
      return len ? { type: "assistant_reply", payload: { replyLen: len } } : null;
    }
    if (["function_call", "local_shell_call", "custom_tool_call", "web_search_call", "computer_call"].includes(String(p.type))) {
      return { type: "tool_use", payload: { tool: String(p.name || p.type) } };
    }
  }
  return null;
}

/** Codex 源文件状态 */
interface CodexFileState {
  bytes: number; started: boolean; finished: boolean; sawGrowth: boolean;
  lastGrowAt: number; firstSeenAt: number; toolCount: number; label: string;
}

/** Codex 源选项 */
export interface CodexSourceOpts extends SourceOpts { dir?: string }

/** Codex 源：jsonl 行增量 + 首扫抑制 + 见过增长才判结束 */
export function createCodexSource({ dir = defaultCodexDir(), emit = () => {}, idleTimeoutMs = 90000, now = () => Date.now() }: CodexSourceOpts = {}): WatcherSource {
  const state = new Map<string, CodexFileState>();
  let firstScan = true;

  function send(type: string, payload: Record<string, unknown>): void {
    try { emit({ type, source: "codex", ts: now(), payload }); } catch { /* 隔离 */ }
  }

  return {
    name: "codex",
    tick() {
      const files = listFiles(dir, (n) => n.endsWith(".jsonl"));
      let events = 0;
      for (const file of files) {
        let st; try { st = statSync(file); } catch { continue; }
        const s = state.get(file) || { bytes: 0, started: false, finished: false, sawGrowth: false, lastGrowAt: st.mtimeMs, firstSeenAt: now(), toolCount: 0, label: "" };
        const isNew = !state.has(file);
        if (st.size < s.bytes) s.bytes = 0;
        let text = "";
        if (s.bytes < st.size) {
          try {
            const fd = openSync(file, "r");
            try { const buf = Buffer.alloc(st.size - s.bytes); readSync(fd, buf, 0, buf.length, s.bytes); text = buf.toString("utf8"); } finally { closeSync(fd); }
          } catch { /* 读失败跳过本 tick */ }
        }
        s.bytes = st.size;
        state.set(file, s);
        if (firstScan) continue; // 首扫只建偏移，不刷屏
        if (isNew && !s.started) {
          s.started = true;
          if (!s.label) s.label = path.basename(path.dirname(file));
          send("agent:session_started", { sessionId: path.basename(file, ".jsonl"), label: s.label, dir: path.dirname(file) });
          events++;
        }
        if (!text) continue;
        for (const line of text.split("\n")) {
          const r = parseCodexLine(line);
          if (!r) continue;
          if (r.type === "meta") { if (!s.label && r.payload.cwd) s.label = baseName(String(r.payload.cwd)); continue; }
          if (r.type === "started") {
            if (!s.started) { s.started = true; send("agent:session_started", { sessionId: path.basename(file, ".jsonl"), label: s.label, dir: path.dirname(file) }); events++; }
            continue;
          }
          if (r.type === "tool_use") { s.toolCount++; send("agent:tool_use", { tool: r.payload.tool, sessionId: path.basename(file, ".jsonl"), label: s.label, dir: path.dirname(file) }); events++; continue; }
          if (r.type === "assistant_reply") { send("agent:assistant_reply", { replyLen: r.payload.replyLen, sessionId: path.basename(file, ".jsonl"), label: s.label, dir: path.dirname(file) }); events++; continue; }
          if (r.type === "finished" && s.started && !s.finished) {
            s.finished = true;
            send("agent:session_finished", { sessionId: path.basename(file, ".jsonl"), label: s.label, durationSec: Math.max(0, Math.round((now() - s.firstSeenAt) / 1000)), toolCount: s.toolCount });
            events++;
          }
        }
        s.sawGrowth = true;
        s.lastGrowAt = now();
      }
      // 结束判定兜底（用 idleTimeoutMs，与其它源一致）：有的 rollout 没有 task_complete
      // （进程被杀/中断/异常退出）——见过增长且 idle 超时同样判结束，否则这类会话会永远停在"进行中"。
      for (const [file, s] of state) {
        if (!s.started || s.finished || !s.sawGrowth) continue;
        if (now() - s.lastGrowAt < idleTimeoutMs) continue;
        s.finished = true;
        send("agent:session_finished", { sessionId: path.basename(file, ".jsonl"), label: s.label, durationSec: Math.max(0, Math.round((now() - s.firstSeenAt) / 1000)), toolCount: s.toolCount });
        events++;
      }
      firstScan = false;
      return events;
    },
    files: () => state.size,
    state: () => ({ source: "codex", files: state.size }),
  };
}

// ============================================================
// DSH：zstd 多帧追加流（~/.dsh/sessions/<proj>/session-<id>/session.jsonl.zstd）
// 帧很多（实测 18.9MB / 37376 帧），全量逐帧解压要 1.2s → 只读文件尾部若干帧
// ============================================================
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** DSH 帧读取结果 */
export interface DshFrames {
  size: number;
  text: string;
  frames: number;
  failed: number;
}

/** DSH 会话头（第一帧：id/cwd/createdAt/agentPreset） */
export interface DshSessionHeader {
  id: string;
  cwd: string;
  createdAt: number;
  agentPreset: string;
}

/** 从指定偏移开始解 zstd 帧（**精确增量**：append-only 流里新帧起点就是上次的 size）
 * 比"读尾部 N 帧"更准：不会把窗口里更早的行当成新事件（那些行没有 time0，时间启发式挡不住——实测踩到）。
 * 落后太多（> maxBytes）时退化为只看尾部，避免一次读几十 MB。
 */
export function readDshFramesFrom(file: string, fromOffset: number, { maxBytes = 524288, maxFrames = 128 }: { maxBytes?: number; maxFrames?: number } = {}): DshFrames | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  let start = Math.max(0, Math.min(Number(fromOffset) || 0, st.size));
  if (st.size - start > maxBytes) start = st.size - maxBytes;
  let buf;
  try {
    const fd = openSync(file, "r");
    try { buf = Buffer.alloc(st.size - start); readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  } catch { return null; }
  const offsets = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) offsets.push(i);
  const parts = [];
  let ok = 0, failed = 0;
  for (const off of offsets) { // 文件顺序：新帧在前，保持时序
    if (ok >= maxFrames) break;
    try { parts.push(zstdDecompressSync(buf.subarray(off)).toString("utf8")); ok++; }
    catch { failed++; } // 尾部半帧/损坏帧（DSH 有"zstd 日志损坏"历史）→ 跳过不炸
  }
  return { size: st.size, text: parts.join(""), frames: ok, failed };
}

/** 读文件尾部 maxBytes 内的 zstd 帧并解压（从最后一个 magic 往前试，最多 maxFrames 帧；诊断/测试用） */
export function readDshTailFrames(file: string, { maxBytes = 262144, maxFrames = 16 }: { maxBytes?: number; maxFrames?: number } = {}): DshFrames | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  const start = Math.max(0, st.size - maxBytes);
  let buf;
  try {
    const fd = openSync(file, "r");
    try { buf = Buffer.alloc(st.size - start); readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  } catch { return null; }
  const offsets = [];
  for (let i = buf.indexOf(ZSTD_MAGIC); i !== -1; i = buf.indexOf(ZSTD_MAGIC, i + 4)) offsets.push(i);
  const parts = [];
  let ok = 0, failed = 0;
  for (let k = offsets.length - 1; k >= 0 && ok < maxFrames; k--) {
    try { parts.push(zstdDecompressSync(buf.subarray(offsets[k])).toString("utf8")); ok++; }
    catch { failed++; } // 尾部半帧/损坏帧（DSH 有"zstd 日志损坏"历史）——跳过不炸
  }
  return { size: st.size, text: parts.reverse().join(""), frames: ok, failed };
}

/** 读文件第一帧（session 头：id/cwd/createdAt）——只在首次见到该会话时读一次 */
export function readDshSessionHeader(file: string): DshSessionHeader | null {
  let st;
  try { st = statSync(file); } catch { return null; }
  let buf;
  try {
    const fd = openSync(file, "r");
    try { buf = Buffer.alloc(Math.min(st.size, 65536)); readSync(fd, buf, 0, buf.length, 0); } finally { closeSync(fd); }
  } catch { return null; }
  if (buf.indexOf(ZSTD_MAGIC) !== 0) return null;
  try {
    const line = zstdDecompressSync(buf).toString("utf8").split("\n")[0];
    const j = JSON.parse(line);
    return { id: String(j.id || ""), cwd: String(j.cwd || ""), createdAt: Number(j.createdAt) || 0, agentPreset: String(j.agentPreset || "") };
  } catch { return null; }
}

/** 解析一行 DSH 会话 jsonl → {type, payload, seq} 或 null（seq0 单调，用于去重） */
export function parseDshLine(line: string): ParsedEvent | null {
  if (!line || !line.trim()) return null;
  let j: any;
  try { j = JSON.parse(line); } catch { return null; }
  const seq = Number(j.seq0 ?? j.seq ?? NaN);
  const t = String(j.type || "");
  const d = j.data || {};
  if (t === "tool/call") {
    const tool = String(d.name || d.tool || d.call?.name || d.server || "tool");
    return { type: "tool_use", payload: { tool }, seq, ts: Number(j.time0) || 0 };
  }
  if (t === "assistant/message") {
    const len = String(d.text ?? "").length || JSON.stringify(d.content ?? "").length;
    return len ? { type: "assistant_reply", payload: { replyLen: len }, seq, ts: Number(j.time0) || 0 } : null;
  }
  return null; // assistant/chunk、reasoning-chunks、text-chunks… 是流式增量，不单独成事件
}

/** DSH 源文件状态 */
interface DshFileState {
  size: number; bootAt: number; lastSeq: number; started: boolean; finished: boolean;
  sawGrowth: boolean; lastGrowAt: number; firstSeenAt: number; toolCount: number; label: string;
}

/** DSH 源选项 */
export interface DshSourceOpts extends SourceOpts { dir?: string; maxBytes?: number; maxFrames?: number }

/** DSH 源：stat 优先（未变化直接跳过）+ 变更时从上次偏移精确解新帧 + seq0 去重
 * 性能（本机实测 578 个会话文件）：不能每 tick 读所有文件——idle tick 只做 stat（实测 ≈50ms）。
 */
export function createDshSource({ dir = defaultDshDir(), emit = () => {}, idleTimeoutMs = 120000, now = () => Date.now(), maxBytes = 524288, maxFrames = 128 }: DshSourceOpts = {}): WatcherSource {
  const state = new Map<string, DshFileState>();
  let firstTick = true;

  function send(type: string, payload: Record<string, unknown>): void {
    try { emit({ type, source: "dsh", ts: now(), payload }); } catch { /* 隔离 */ }
  }

  /** 会话名：优先读会话头 cwd 的目录名（--D-mianshi-agent-- 这类编码名不可读）；失败回落目录名 */
  function resolveLabel(file: string): string {
    const h = readDshSessionHeader(file);
    if (h?.cwd) return baseName(h.cwd);
    return path.basename(path.dirname(path.dirname(file))).replace(/^-+|-+$/g, "");
  }

  return {
    name: "dsh",
    tick() {
      const files = listFiles(dir, (n) => n === "session.jsonl.zstd");
      const nowMs = now();
      let events = 0;
      for (const file of files) {
        let st;
        try { st = statSync(file); } catch { continue; }
        const prev = state.get(file);
        if (!prev) {
          // 首次见到：只登记。首 tick 里出现的 = 历史会话（不刷屏）；之后的 = 新会话 → 播报
          const created: DshFileState = {
            size: st.size, bootAt: nowMs, lastSeq: -1, started: !firstTick, finished: false,
            sawGrowth: false, lastGrowAt: nowMs, firstSeenAt: nowMs, toolCount: 0, label: "",
          };
          state.set(file, created);
          if (!firstTick) {
            created.label = resolveLabel(file);
            send("agent:session_started", { sessionId: path.basename(path.dirname(file)), label: created.label, dir: path.dirname(file) });
            events++;
          }
          continue;
        }
        if (st.size === prev.size) continue; // 未变化：只 stat 不读（578 个会话的 idle tick 成本 ≈ 0）
        if (st.size < prev.size) { prev.size = st.size; continue; } // 被截断/重写：重新对齐偏移，本 tick 不发事件
        const delta = readDshFramesFrom(file, prev.size, { maxBytes, maxFrames });
        if (!delta || !delta.text) { prev.size = st.size; continue; }
        prev.size = delta.size;
        if (!prev.label) prev.label = resolveLabel(file);
        for (const line of delta.text.split("\n")) {
          const r = parseDshLine(line);
          if (!r) continue;
          const seq = r.seq;
          if (typeof seq === "number" && Number.isFinite(seq)) { // 帧区间重叠时的兜底去重（正常路径下 offset 已经保证不重放）
            if (seq <= prev.lastSeq) continue;
            prev.lastSeq = seq;
          }
          if (r.type === "tool_use") { prev.toolCount++; send("agent:tool_use", { tool: r.payload.tool, sessionId: path.basename(path.dirname(file)), label: prev.label, dir: path.dirname(file) }); events++; }
          else if (r.type === "assistant_reply") { send("agent:assistant_reply", { replyLen: r.payload.replyLen, sessionId: path.basename(path.dirname(file)), label: prev.label, dir: path.dirname(file) }); events++; }
        }
        prev.sawGrowth = true;
        prev.lastGrowAt = nowMs;
      }
      // 结束判定：见过增长 + 超过 idle 没再变
      for (const [file, s] of state) {
        if (!s.started || s.finished || !s.sawGrowth) continue;
        if (nowMs - s.lastGrowAt < idleTimeoutMs) continue;
        s.finished = true;
        send("agent:session_finished", { sessionId: path.basename(path.dirname(file)), label: s.label, durationSec: Math.max(0, Math.round((nowMs - s.firstSeenAt) / 1000)), toolCount: s.toolCount });
        events++;
      }
      firstTick = false;
      return events;
    },
    files: () => state.size,
    state: () => ({ source: "dsh", files: state.size }),
  };
}

// ============================================================
// OpenCode：SQLite 只读轮询（库 1.7GB，必须按 rowid 增量取，不能全表扫）
// ============================================================
/**
 * 解析 part.data（JSON 字符串）→ 归一化事件或 null
 */
export function parseOpenCodePart(raw: unknown): ParsedEvent | null {
  let d: any;
  try { d = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return null; }
  const t = String(d?.type || "");
  if (t === "tool") {
    const tool = String(d?.tool || d?.name || "tool");
    return { type: "tool_use", payload: { tool } };
  }
  if (t === "text") {
    const len = String(d?.text || "").length;
    return len ? { type: "assistant_reply", payload: { replyLen: len } } : null;
  }
  if (t === "reasoning" || t === "step-start" || t === "step-finish" || t === "snapshot" || t === "patch") return null;
  return null;
}

/** OpenCode 活跃会话状态 */
interface OpenCodeSessionState {
  label: string; firstSeenAt: number; lastActivity: number; toolCount: number;
}

/** OpenCode 源选项 */
export interface OpenCodeSourceOpts extends SourceOpts { dbPath?: string }

/** OpenCode 源：session/part 按 rowid 轮询（只读打开；库被占用时本 tick 静默跳过） */
export function createOpenCodeSource({ dbPath = defaultOpenCodeDb(), emit = () => {}, idleTimeoutMs = 180000, now = () => Date.now() }: OpenCodeSourceOpts = {}): WatcherSource {
  let db: DatabaseSync | null = null;
  let lastSessionRow = 0, lastPartRow = 0;
  const active = new Map<string, OpenCodeSessionState>(); // sessionId → { label, firstSeenAt, lastActivity, toolCount }
  const finished = new Set<string>();
  let firstScan = true;

  function send(type: string, payload: Record<string, unknown>): void {
    try { emit({ type, source: "opencode", ts: now(), payload }); } catch { /* 隔离 */ }
  }

  function open(): DatabaseSync | null {
    if (db) return db;
    if (!existsSync(dbPath)) return null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      // 游标直接跳到当前最大 rowid：库里可能有几万条历史 part（本机 77624 条），
      // 若用 LIMIT 分批从头拉，第二批会把历史积压当新事件重放（实测踩到：idle tick 冒出 199 条）。
      lastSessionRow = Number(db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM session").get()?.m || 0);
      lastPartRow = Number(db.prepare("SELECT COALESCE(MAX(rowid), 0) AS m FROM part").get()?.m || 0);
    } catch { db = null; }
    return db;
  }

  return {
    name: "opencode",
    tick() {
      const d = open();
      if (!d) return 0;
      let events = 0;
      let rows: Array<Record<string, unknown>>;
      try {
        rows = d.prepare("SELECT rowid AS rid, id, title, directory, time_created, time_updated FROM session WHERE rowid > ? ORDER BY rowid LIMIT 50").all(lastSessionRow) as Array<Record<string, unknown>>;
      } catch { return 0; } // 库被写锁/结构不符 → 本 tick 跳过
      for (const r of rows) {
        lastSessionRow = Math.max(lastSessionRow, Number(r.rid));
        if (firstScan) continue;
        const label = String(r.title || path.basename(String(r.directory || "")) || r.id);
        active.set(String(r.id), { label, firstSeenAt: now(), lastActivity: Number(r.time_updated) || now(), toolCount: 0 });
        send("agent:session_started", { sessionId: String(r.id), label, dir: String(r.directory || "") });
        events++;
      }
      let parts: Array<Record<string, unknown>>;
      try {
        parts = d.prepare("SELECT rowid AS rid, session_id, time_created, data FROM part WHERE rowid > ? ORDER BY rowid LIMIT 300").all(lastPartRow) as Array<Record<string, unknown>>;
      } catch { parts = []; }
      for (const p of parts) {
        lastPartRow = Math.max(lastPartRow, Number(p.rid));
        const sid = String(p.session_id);
        const a = active.get(sid);
        if (a) a.lastActivity = Number(p.time_created) || a.lastActivity;
        if (firstScan) continue;
        const ev = parseOpenCodePart(String(p.data));
        if (!ev) continue;
        if (ev.type === "tool_use") { if (a) a.toolCount++; else active.set(sid, { label: sid, firstSeenAt: now(), lastActivity: now(), toolCount: 1 }); send("agent:tool_use", { tool: ev.payload.tool, sessionId: sid, label: active.get(sid)?.label || sid }); events++; }
        else if (ev.type === "assistant_reply") { send("agent:assistant_reply", { replyLen: ev.payload.replyLen, sessionId: sid, label: active.get(sid)?.label || sid }); events++; }
      }
      firstScan = false;
      // 结束判定：本进程内见过该会话活动 + 静默超时
      for (const [sid, a] of active) {
        if (finished.has(sid)) continue;
        if (now() - a.lastActivity < idleTimeoutMs) continue;
        finished.add(sid);
        send("agent:session_finished", { sessionId: sid, label: a.label, durationSec: Math.max(0, Math.round((now() - a.firstSeenAt) / 1000)), toolCount: a.toolCount });
        events++;
      }
      return events;
    },
    close: () => { try { db?.close(); } catch { /* ignore */ } db = null; },
    state: () => ({ source: "opencode", sessions: active.size, lastSessionRow, lastPartRow }),
  };
}

// ============================================================
// 聚合：四源一起 tick（widget 用 setInterval 调 tick；测试直接调）
// ============================================================
/** createAgentWatcher 选项（各路径可用环境变量覆盖：非标准安装位置 / 端到端测试指向临时目录） */
export interface AgentWatcherOpts extends SourceOpts {
  sources?: string[];
  ccDir?: string;
  codexDir?: string;
  dshDir?: string;
  opencodeDb?: string;
  env?: Record<string, string | undefined>;
}

export function createAgentWatcher({
  emit = () => {},
  idleTimeoutMs = 90000,
  sources,
  ccDir,
  codexDir,
  dshDir,
  opencodeDb,
  env = process.env,
  now = () => Date.now(),
}: AgentWatcherOpts = {}) {
  // 路径可用环境变量覆盖（非标准安装位置 / 端到端测试指向临时目录）
  const ccPath = ccDir || env.MIANSHI_CC_DIR || defaultCcDir();
  const codexPath = codexDir || env.MIANSHI_CODEX_DIR || defaultCodexDir();
  const dshPath = dshDir || env.MIANSHI_DSH_DIR || defaultDshDir();
  const opencodePath = opencodeDb || env.MIANSHI_OPENCODE_DB || defaultOpenCodeDb();
  // 开关：MIANSHI_AGENT_WATCH=0 全关；各源另有 MIANSHI_<X>_WATCH=0（保持旧 MIANSHI_CC_WATCH 语义）
  const on = (k: string): boolean => String(env[k] ?? "1") !== "0";
  const allOff = String(env.MIANSHI_AGENT_WATCH ?? "1") === "0";
  const wanted: string[] = sources || (allOff ? [] : [
    on("MIANSHI_CC_WATCH") ? "claude-code" : null,
    on("MIANSHI_CODEX_WATCH") ? "codex" : null,
    on("MIANSHI_DSH_WATCH") ? "dsh" : null,
    on("MIANSHI_OPENCODE_WATCH") ? "opencode" : null,
  ].filter((x): x is string => !!x));

  const adapters: WatcherSource[] = [];
  if (wanted.includes("claude-code")) {
    // cc-watcher 是既有实现（返回 {tick, stop, files}）——这里适配成统一源接口
    const cc = createCcWatcher({ ccDir: ccPath, emit, idleTimeoutMs });
    adapters.push({
      name: "claude-code",
      tick: () => Number(cc.tick()?.newEvents || 0),
      close: () => { try { cc.stop?.(); } catch { /* ignore */ } },
      state: () => ({ source: "claude-code", files: Number(cc.files?.() || 0) }),
    });
  }
  if (wanted.includes("codex")) adapters.push(createCodexSource({ dir: codexPath, emit, idleTimeoutMs, now }));
  if (wanted.includes("dsh")) adapters.push(createDshSource({ dir: dshPath, emit, idleTimeoutMs, now }));
  if (wanted.includes("opencode")) adapters.push(createOpenCodeSource({ dbPath: opencodePath, emit, idleTimeoutMs, now }));

  return {
    sources: () => adapters.map((a) => a.name),
    /** 扫描一次全部源，返回 { sources, newEvents, detail } */
    tick() {
      let newEvents = 0;
      const detail: Record<string, number | string> = {};
      for (const a of adapters) {
        try {
          const n = a.tick();
          newEvents += n;
          detail[a.name] = n;
        } catch (e) {
          detail[a.name] = `error: ${String(e instanceof Error ? e.message : e).slice(0, 80)}`;
        }
      }
      return { sources: adapters.length, newEvents, detail };
    },
    stop() {
      for (const a of adapters) { try { a.close?.(); } catch { /* ignore */ } }
    },
    state: () => adapters.map((a) => (a.state ? a.state() : { source: a.name })),
  };
}
