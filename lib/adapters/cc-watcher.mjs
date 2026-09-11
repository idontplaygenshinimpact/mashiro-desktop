// CC 会话文件 watcher（Phase 事件驱动内核 W2 §4.1）——零侵入感知源（多源感知的 claude-code 适配器）
// 监听 ~/.claude/projects/**/*.jsonl（Claude Code 会话日志，增量可解析），
// 把会话活动解析为事件元数据（类型/时长/工具名/回复长度），**不落 CC 正文内容**到项目库。
// 设计：
//   - 行级增量解析：记录每个文件已解析字节偏移（内存 Map），重复扫描幂等（不重复出事件）
//   - 首次全量扫描只建立偏移不发事件（重启不刷屏）；新文件出现 → session_started
//   - 文件停止增长超过 idleTimeout → session_finished（一次，且**必须本进程内见过增长**）
//   - 开关：MIANSHI_CC_WATCH=0 关闭（受 MIANSHI_DISABLE_BACKGROUND 一并约束，由接线方控制）
// 事件输出（通过注入的 emit 回调；2026-09-11 起统一为通用 agent:* 命名，多源共用）：
//   agent:session_started {source:'claude-code', sessionId, label, dir} / agent:tool_use {tool}
//   agent:assistant_reply {replyLen} / agent:session_finished {sessionId, durationSec, toolCount}
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
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
 * @param {{ ccDir?: string, emit?: (ev: {type: string, source: string, ts: number, payload: object}) => void, idleTimeoutMs?: number }} opts
 * @returns {{ tick: () => {files: number, newEvents: number}, stop: () => void, files(): number }}
 */
export function createCcWatcher({ ccDir = defaultCcDir(), emit = () => {}, idleTimeoutMs = 90000 } = {}) {
  /** @type {Map<string, {bytes: number, started: boolean, finished: boolean, sawGrowth: boolean, lastGrowAt: number, firstSeenAt: number, toolCount: number}>} */
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
    try { emit({ type, source: "claude-code", ts: Date.now(), payload }); } catch { /* 总线失败隔离 */ }
  }

  function scanOne(file) {
    let st;
    try { st = statSync(file); } catch { return 0; }
    const s = state.get(file) || { bytes: 0, started: false, finished: false, sawGrowth: false, lastGrowAt: st.mtimeMs, firstSeenAt: Date.now(), toolCount: 0 };
    // 增量读（性能工单任务 4：文件可能 MB 级——只读新增段，不每 2s 全量 readFileSync）
    // 截断/重写（字节回退）：从 0 重扫（已存在会话不再发 started）
    if (st.size < s.bytes) s.bytes = 0;
    let content = "";
    try {
      const fd = openSync(file, "r");
      try {
        if (s.bytes < st.size) {
          const buf = Buffer.alloc(st.size - s.bytes);
          readSync(fd, buf, 0, buf.length, s.bytes);
          content = buf.toString("utf8");
        }
      } finally { closeSync(fd); }
    } catch { return 0; }
    let newEvents = 0;

    // 新文件（本 tick 前不存在）→ 标记 started；首扫只标记不发事件（重启不刷屏）
    if (!state.has(file)) {
      s.started = true;
      if (!firstScan) {
        const sid = path.basename(file, ".jsonl");
        emitEvent("agent:session_started", { sessionId: sid, label: path.basename(path.dirname(file)), dir: path.dirname(file) });
        newEvents++;
      }
    }
    state.set(file, s);

    // 首次扫描：只建偏移（st.size + 最后增长时间），不读内容不解析事件（重启不刷屏）
    if (firstScan) {
      s.bytes = st.size;
      s.lastGrowAt = Date.now();
      return newEvents;
    }

    // 增量解析（content 已是新增段——字节偏移：append 只增尾部，精确；行尾空行不影响偏移）
    const delta = content;
    s.bytes = st.size;
    if (delta) {
      for (const l of delta.split("\n")) {
        const r = parseCcLine(l);
        if (!r) continue;
        if (r.type === "tool_use") {
          s.toolCount++;
          emitEvent("agent:tool_use", { tool: r.payload.tool });
        } else if (r.type === "assistant_reply") {
          emitEvent("agent:assistant_reply", { replyLen: r.payload.replyLen });
        }
        newEvents++;
      }
      s.sawGrowth = true; // 本进程内见过增长——只有这种会话才允许判"结束"（见 checkFinished）
      s.lastGrowAt = Date.now();
    }
    return newEvents;
  }

  /**
   * 会话结束判定：已 started、**本进程内见过增长**、未 finished、超过 idleTimeoutMs 无增长 → session_finished
   * 2026-09-11 修：此前不看 sawGrowth——启动时把**静止的历史会话文件**标记为 started，等 idleTimeout 一到就发
   * 一条假的 "session_finished"（实测本机 decision_ledger 里 128 条 autonomy:cc:session_finished 大部分是这么来的，
   * 因为 ~/.claude/projects 只有一个 7 月就不再更新的 jsonl，而桌宠重启过很多次）。
   */
  function checkFinished(file, now = Date.now()) {
    const s = state.get(file);
    if (!s || !s.started || s.finished || !s.sawGrowth) return 0;
    if (now - s.lastGrowAt < idleTimeoutMs) return 0;
    s.finished = true;
    const durationSec = Math.max(0, Math.round((now - s.firstSeenAt) / 1000));
    emitEvent("agent:session_finished", { sessionId: path.basename(file, ".jsonl"), label: path.basename(path.dirname(file)), durationSec, toolCount: s.toolCount });
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
