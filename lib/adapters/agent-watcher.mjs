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

/** 默认端口/目录（全部可用参数覆盖，测试注入临时目录） */
export const defaultCodexDir = () => path.join(os.homedir(), ".codex", "sessions");
export const defaultDshDir = () => path.join(os.homedir(), ".dsh", "sessions");
export const defaultOpenCodeDb = () => path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");

/**
 * 归一化后的 agent 会话事件（与 lib/events.ts 的统一事件模型同形）
 * @typedef {{ type: string, source: string, ts: number, payload: Record<string, unknown> }} AgentEvent
 */
/** @typedef {(ev: AgentEvent) => void} AgentEmit */

/**
 * 各源工厂的公共选项（注意：emit 必须显式标注类型——默认值 `() => {}` 会被推断成"零参函数"，
 * checkJs 下调用 emit(ev) 会报 TS2554）
 * @typedef {{ emit?: AgentEmit, idleTimeoutMs?: number, now?: () => number }} SourceOpts
 */

// ---------- 通用：目录递归列文件 ----------
/** 跨平台取路径最后一段：会话文件里的 cwd/directory 可能来自另一平台风格，
 *  `path.basename` 在 Linux 上不认反斜杠（CI 实测：D:\proj 会整串返回）→ 两种分隔符都切 */
const baseName = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";

function listFiles(dir, match) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
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
 * @param {string} line
 * @returns {{type: string, payload: Record<string, unknown>} | null}
 */
export function parseCodexLine(line) {
  if (!line || !line.trim()) return null;
  let j;
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
        ? p.content.reduce((n, c) => n + String(c?.text || "").length, 0)
        : String(p.content || "").length;
      return len ? { type: "assistant_reply", payload: { replyLen: len } } : null;
    }
    if (["function_call", "local_shell_call", "custom_tool_call", "web_search_call", "computer_call"].includes(String(p.type))) {
      return { type: "tool_use", payload: { tool: String(p.name || p.type) } };
    }
  }
  return null;
}

/** Codex 源：jsonl 行增量 + 首扫抑制 + 见过增长才判结束
 * @param {SourceOpts & { dir?: string }} [opts]
 */
export function createCodexSource({ dir = defaultCodexDir(), emit = () => {}, idleTimeoutMs = 90000, now = () => Date.now() } = {}) {
  /** @type {Map<string, {bytes:number, started:boolean, finished:boolean, sawGrowth:boolean, lastGrowAt:number, firstSeenAt:number, toolCount:number, label:string}>} */
  const state = new Map();
  let firstScan = true;

  function send(type, payload) {
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

/** 从指定偏移开始解 zstd 帧（**精确增量**：append-only 流里新帧起点就是上次的 size）
 * 比"读尾部 N 帧"更准：不会把窗口里更早的行当成新事件（那些行没有 time0，时间启发式挡不住——实测踩到）。
 * 落后太多（> maxBytes）时退化为只看尾部，避免一次读几十 MB。
 */
export function readDshFramesFrom(file, fromOffset, { maxBytes = 524288, maxFrames = 128 } = {}) {
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
export function readDshTailFrames(file, { maxBytes = 262144, maxFrames = 16 } = {}) {
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
export function readDshSessionHeader(file) {
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
export function parseDshLine(line) {
  if (!line || !line.trim()) return null;
  let j;
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

/** DSH 源：stat 优先（未变化直接跳过）+ 变更时从上次偏移精确解新帧 + seq0 去重
 * 性能（本机实测 578 个会话文件）：不能每 tick 读所有文件——idle tick 只做 stat（实测 ≈50ms）。
 * @param {SourceOpts & { dir?: string, maxBytes?: number, maxFrames?: number }} [opts]
 */
export function createDshSource({ dir = defaultDshDir(), emit = () => {}, idleTimeoutMs = 120000, now = () => Date.now(), maxBytes = 524288, maxFrames = 128 } = {}) {
  /** @type {Map<string, {size:number, bootAt:number, lastSeq:number, started:boolean, finished:boolean, sawGrowth:boolean, lastGrowAt:number, firstSeenAt:number, toolCount:number, label:string}>} */
  const state = new Map();
  let firstTick = true;

  function send(type, payload) {
    try { emit({ type, source: "dsh", ts: now(), payload }); } catch { /* 隔离 */ }
  }

  /** 会话名：优先读会话头 cwd 的目录名（--D-mianshi-agent-- 这类编码名不可读）；失败回落目录名 */
  function resolveLabel(file) {
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
          state.set(file, {
            size: st.size, bootAt: nowMs, lastSeq: -1, started: !firstTick, finished: false,
            sawGrowth: false, lastGrowAt: nowMs, firstSeenAt: nowMs, toolCount: 0, label: "",
          });
          if (!firstTick) {
            const s = state.get(file);
            s.label = resolveLabel(file);
            send("agent:session_started", { sessionId: path.basename(path.dirname(file)), label: s.label, dir: path.dirname(file) });
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
          if (Number.isFinite(r.seq)) { // 帧区间重叠时的兜底去重（正常路径下 offset 已经保证不重放）
            if (r.seq <= prev.lastSeq) continue;
            prev.lastSeq = r.seq;
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
 * @param {string} raw
 */
export function parseOpenCodePart(raw) {
  let d;
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

/** OpenCode 源：session/part 按 rowid 轮询（只读打开；库被占用时本 tick 静默跳过）
 * @param {SourceOpts & { dbPath?: string }} [opts]
 */
export function createOpenCodeSource({ dbPath = defaultOpenCodeDb(), emit = () => {}, idleTimeoutMs = 180000, now = () => Date.now() } = {}) {
  /** @type {DatabaseSync | null} */
  let db = null;
  let lastSessionRow = 0, lastPartRow = 0;
  const active = new Map(); // sessionId → { label, firstSeenAt, lastActivity, toolCount }
  const finished = new Set();
  let firstScan = true;

  function send(type, payload) {
    try { emit({ type, source: "opencode", ts: now(), payload }); } catch { /* 隔离 */ }
  }

  function open() {
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
      /** @type {Array<Record<string, unknown>>} */
      let rows;
      try {
        rows = d.prepare("SELECT rowid AS rid, id, title, directory, time_created, time_updated FROM session WHERE rowid > ? ORDER BY rowid LIMIT 50").all(lastSessionRow);
      } catch { return 0; } // 库被写锁/结构不符 → 本 tick 跳过
      for (const r of rows) {
        lastSessionRow = Math.max(lastSessionRow, Number(r.rid));
        if (firstScan) continue;
        const label = String(r.title || path.basename(String(r.directory || "")) || r.id);
        active.set(String(r.id), { label, firstSeenAt: now(), lastActivity: Number(r.time_updated) || now(), toolCount: 0 });
        send("agent:session_started", { sessionId: String(r.id), label, dir: String(r.directory || "") });
        events++;
      }
      /** @type {Array<Record<string, unknown>>} */
      let parts;
      try {
        parts = d.prepare("SELECT rowid AS rid, session_id, time_created, data FROM part WHERE rowid > ? ORDER BY rowid LIMIT 300").all(lastPartRow);
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
/**
 * @param {{ emit?: (ev: {type:string, source:string, ts:number, payload:object}) => void, idleTimeoutMs?: number,
 *   sources?: string[], ccDir?: string, codexDir?: string, dshDir?: string, opencodeDb?: string,
 *   env?: Record<string, string | undefined>, now?: () => number }} [opts]
 */
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
} = {}) {
  // 路径可用环境变量覆盖（非标准安装位置 / 端到端测试指向临时目录）
  const ccPath = ccDir || env.MIANSHI_CC_DIR || defaultCcDir();
  const codexPath = codexDir || env.MIANSHI_CODEX_DIR || defaultCodexDir();
  const dshPath = dshDir || env.MIANSHI_DSH_DIR || defaultDshDir();
  const opencodePath = opencodeDb || env.MIANSHI_OPENCODE_DB || defaultOpenCodeDb();
  // 开关：MIANSHI_AGENT_WATCH=0 全关；各源另有 MIANSHI_<X>_WATCH=0（保持旧 MIANSHI_CC_WATCH 语义）
  const on = (k) => String(env[k] ?? "1") !== "0";
  const allOff = String(env.MIANSHI_AGENT_WATCH ?? "1") === "0";
  const wanted = sources || (allOff ? [] : [
    on("MIANSHI_CC_WATCH") ? "claude-code" : null,
    on("MIANSHI_CODEX_WATCH") ? "codex" : null,
    on("MIANSHI_DSH_WATCH") ? "dsh" : null,
    on("MIANSHI_OPENCODE_WATCH") ? "opencode" : null,
  ].filter(Boolean));

  const adapters = [];
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
      const detail = {};
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
