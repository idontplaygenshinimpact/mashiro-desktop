// CC 会话文件 watcher（Phase 事件驱动内核 W2 §4.1）——零侵入感知源
// 监听 ~/.claude/projects/**/*.jsonl（Claude Code 会话日志，增量可解析），
// 把会话活动解析为事件元数据（类型/时长/工具名/回复长度），**不落 CC 正文内容**到项目库。
// 设计：
//   - 行级增量解析：记录每个文件已解析行数（内存 Map），重复扫描幂等（不重复出事件）
//   - 首次全量扫描只建立偏移不发事件（重启不刷屏）；新文件出现 → session_started
//   - 文件停止增长超过 idleTimeout → session_finished（一次）
//   - 开关：MIANSHI_CC_WATCH=0 关闭（受 MIANSHI_DISABLE_BACKGROUND 一并约束，由接线方控制）
// 事件输出（通过注入的 emit 回调）：
//   cc:session_started {sessionId, dir} / cc:tool_use {tool} / cc:assistant_reply {replyLen}
//   cc:session_finished {sessionId, durationSec, toolCount}
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export const defaultCcDir = () => path.join(os.homedir(), ".claude", "projects");

/** 解析一行 jsonl（Claude Code 会话消息），返回 {type, payload} 或 null */
export function parseCcLine(line) {
  if (!line || !line.trim()) return null;
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const ts = typeof j.timestamp === "string" ? new Date(j.timestamp).getTime() : Date.now();
  const m = j.message || {};
  if (j.type === "assistant") {
    if (m.tool_use && typeof m.tool_use.name === "string") {
      return { type: "tool_use", payload: { tool: m.tool_use.name }, ts };
    }
    if (m.role === "assistant" || m.content) {
      // 回复产出：统计 text 块总长（元数据，不取正文）
      let replyLen = 0;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === "text" && typeof c.text === "string") replyLen += c.text.length;
        }
      } else if (typeof m.content === "string") {
        replyLen = m.content.length;
      }
      if (replyLen > 0) return { type: "assistant_reply", payload: { replyLen }, ts };
    }
  }
  return null;
}

/**
 * 创建 CC watcher（手动 tick 驱动：widget 用 setInterval 调 tick；测试直接调 tick）
 * @param {{ ccDir?: string, emit: (ev: {type: string, source: string, ts: number, payload: object}) => void, idleTimeoutMs?: number, log?: (msg: string) => void }} opts
 * @returns {{ tick: () => {files: number, newEvents: number}, stop: () => void, files(): number }}
 */
export function createCcWatcher({ ccDir = defaultCcDir(), emit, idleTimeoutMs = 90000, log = console.log } = {}) {
  /** @type {Map<string, {lines: number, started: boolean, finished: boolean, lastGrowAt: number, firstSeenAt: number, toolCount: number}>} */
  const state = new Map();
  let firstScan = true;

  function listJsonlFiles() {
    if (!existsSync(ccDir)) return [];
    const out = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".jsonl")) out.push(p);
      }
    };
    walk(ccDir);
    return out;
  }

  function emitEvent(type, payload) {
    try { emit({ type, source: "cc-watcher", ts: Date.now(), payload }); } catch { /* 总线失败隔离 */ }
  }

  function scanOne(file) {
    let st;
    try { st = statSync(file); } catch { return 0; }
    const s = state.get(file) || { bytes: 0, started: false, finished: false, lastGrowAt: st.mtimeMs, firstSeenAt: Date.now(), toolCount: 0 };
    let content;
    try { content = readFileSync(file, "utf8"); } catch { return 0; }
    let newEvents = 0;

    // 文件被截断/重写（字节回退）：从 0 重扫（已存在会话不再发 started）
    if (content.length < s.bytes) s.bytes = 0;

    // 新文件（本 tick 前不存在）→ 标记 started；首扫只标记不发事件（重启不刷屏）
    if (!state.has(file)) {
      s.started = true;
      if (!firstScan) {
        const sid = path.basename(file, ".jsonl");
        emitEvent("cc:session_started", { sessionId: sid, dir: path.dirname(file) });
        newEvents++;
      }
    }
    state.set(file, s);

    // 首次扫描：只建偏移（字节数 + 最后增长时间），不解析事件（重启不刷屏）
    if (firstScan) {
      s.bytes = content.length;
      s.lastGrowAt = Date.now();
      return newEvents;
    }

    // 增量解析（字节偏移：append 只增尾部，精确；行尾空行不影响偏移）
    const delta = content.slice(s.bytes);
    s.bytes = content.length;
    if (delta) {
      for (const l of delta.split("\n")) {
        const r = parseCcLine(l);
        if (!r) continue;
        if (r.type === "tool_use") {
          s.toolCount++;
          emitEvent("cc:tool_use", { tool: r.payload.tool });
        } else if (r.type === "assistant_reply") {
          emitEvent("cc:assistant_reply", { replyLen: r.payload.replyLen });
        }
        newEvents++;
      }
      s.lastGrowAt = Date.now();
    }
    return newEvents;
  }

  /** 会话结束判定：已 started、未 finished、超过 idleTimeoutMs 无增长 → session_finished */
  function checkFinished(file, now = Date.now()) {
    const s = state.get(file);
    if (!s || !s.started || s.finished) return 0;
    if (now - s.lastGrowAt < idleTimeoutMs) return 0;
    s.finished = true;
    const durationSec = Math.max(0, Math.round((now - s.firstSeenAt) / 1000));
    emitEvent("cc:session_finished", { sessionId: path.basename(file, ".jsonl"), durationSec, toolCount: s.toolCount });
    return 1;
  }

  return {
    /** 扫描一次：解析增量 + 判定结束。返回 {files, newEvents} */
    tick() {
      const files = listJsonlFiles();
      let newEvents = 0;
      for (const f of files) newEvents += scanOne(f);
      const now = Date.now();
      for (const f of files) newEvents += checkFinished(f, now);
      // 首次扫描：只建偏移（不发事件）
      if (firstScan) {
        firstScan = false;
        return { files: files.length, newEvents: 0, bootstrapped: true };
      }
      return { files: files.length, newEvents };
    },
    stop() { state.clear(); firstScan = true; },
    files() { return state.size; },
  };
}
