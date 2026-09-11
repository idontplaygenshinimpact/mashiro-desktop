// Agent 会话时间线 + 项目投入统计（2026-09-11，方向 A：把感知层信号"沉淀成数据"而不是"播报"）
//
// 为什么做：感知层（DSH / OpenCode / Codex / Claude Code 四源）信号很密——本机一段几小时的会话里
// 537 次工具调用 + 324 条回复事件；但决策层把其中 98% 丢掉（工具调用静默 + 5s 防抖 + 60s 寂静期 +
// 每日 20 条预算），剩下的还是"出结果了，去看看"这种零信息量文案（自评：陪伴价值 > 效率价值）。
// 这里把同一份信号落成可查数据：**会话 × 项目 × 时长 × 轮次 × 工具调用**，面板可看、可截图、可量化。
//
// 两张表：
//   agent_sessions     每会话一行（source/session_id/project/dir/started_at/last_activity_at/ended_at/turns/tool_calls/partial）
//   agent_tool_events  每次工具调用一行（ts/source/project/tool/session_id）→ Top 工具 / 按天分布
// 写入路径：
//   ① 实时：感知层事件 → recordAgentEvent()（widget 在事件总线回调里调用）
//   ② 历史回填：backfillAgentSessions()——OpenCode 用 SQL 精确聚合（266 会话 / 19340 消息 / 77624 part），
//      DSH 用「会话头 createdAt + 文件 mtime」近似（578 个会话文件，不逐帧解压），Codex / Claude Code 走 jsonl 行扫描。
// 幂等：全部按 id UPSERT，重复回填/重复事件不会翻倍（轮次与工具数是**增量累加**，回填标记 partial 区分口径）。
import { db } from "./db.mjs";
import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { readDshSessionHeader } from "./adapters/agent-watcher.mjs";
import type { UnifiedEvent } from "./events.mjs";

db.exec(`
CREATE TABLE IF NOT EXISTS agent_sessions (
  id TEXT PRIMARY KEY,           -- <source>:<sessionId>
  source TEXT NOT NULL,          -- dsh | opencode | codex | claude-code
  session_id TEXT NOT NULL,
  project TEXT,                  -- 项目/会话名（cwd 目录名 / opencode title）
  dir TEXT,
  started_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  ended_at INTEGER DEFAULT 0,
  turns INTEGER DEFAULT 0,       -- assistant_reply 次数
  tool_calls INTEGER DEFAULT 0,
  partial INTEGER DEFAULT 0,     -- 1 = 历史回填（轮次/工具数未采集，只有时长）
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_last ON agent_sessions(last_activity_at);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_project ON agent_sessions(project);

CREATE TABLE IF NOT EXISTS agent_tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  source TEXT NOT NULL,
  project TEXT,
  tool TEXT NOT NULL,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tools_ts ON agent_tool_events(ts);
`);

/** 一条 agent 会话（面板展示用） */
export interface AgentSession {
  id: string;
  source: string;
  project: string;
  dir: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number;
  turns: number;
  toolCalls: number;
  partial: boolean;
}

/** 项目投入聚合行 */
export interface ProjectStat {
  project: string;
  sources: string[];
  sessions: number;
  minutes: number;
  turns: number;
  toolCalls: number;
  lastActivityAt: number;
}

// ---------- 写入（实时） ----------
const upsertSession = db.prepare(`
INSERT INTO agent_sessions (id, source, session_id, project, dir, started_at, last_activity_at, ended_at, turns, tool_calls, partial, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
ON CONFLICT(id) DO UPDATE SET
  project = CASE WHEN excluded.project != '' THEN excluded.project ELSE agent_sessions.project END,
  dir = CASE WHEN excluded.dir != '' THEN excluded.dir ELSE agent_sessions.dir END,
  started_at = MIN(agent_sessions.started_at, excluded.started_at),
  last_activity_at = MAX(agent_sessions.last_activity_at, excluded.last_activity_at),
  ended_at = CASE WHEN excluded.ended_at > 0 THEN excluded.ended_at ELSE agent_sessions.ended_at END,
  turns = agent_sessions.turns + excluded.turns,
  tool_calls = agent_sessions.tool_calls + excluded.tool_calls,
  updated_at = excluded.updated_at
`);
const insertTool = db.prepare("INSERT INTO agent_tool_events (ts, source, project, tool, session_id) VALUES (?, ?, ?, ?, ?)");

/**
 * 记录一条 agent 会话事件（实时增量）。
 * 只认带 sessionId 的事件——感知层四种源都会在 payload 里带 sessionId/label（见 adapters/agent-watcher.mjs）。
 * @param {UnifiedEvent} ev
 * @returns {boolean} 是否记入
 */
export function recordAgentEvent(ev: UnifiedEvent | null | undefined): boolean {
  const type = String(ev?.type || "");
  if (!type.startsWith("agent:")) return false;
  const p = (ev?.payload || {}) as Record<string, unknown>;
  const sessionId = String(p.sessionId || "");
  if (!sessionId) return false;
  const source = String(ev?.source || "unknown");
  const ts = Number(ev?.ts) || Date.now();
  const project = String(p.label || "");
  const dir = String(p.dir || "");
  const id = `${source}:${sessionId}`;
  try {
    if (type === "agent:tool_use") {
      upsertSession.run(id, source, sessionId, project, dir, ts, ts, 0, 0, 1, ts);
      insertTool.run(ts, source, project, String(p.tool || "tool"), sessionId);
      return true;
    }
    if (type === "agent:assistant_reply") {
      upsertSession.run(id, source, sessionId, project, dir, ts, ts, 0, 1, 0, ts);
      return true;
    }
    if (type === "agent:session_started") {
      upsertSession.run(id, source, sessionId, project, dir, ts, ts, 0, 0, 0, ts);
      return true;
    }
    if (type === "agent:session_finished") {
      upsertSession.run(id, source, sessionId, project, dir, ts, ts, ts, 0, 0, ts);
      return true;
    }
  } catch { /* 记录失败不影响主流程（感知/播报优先级更高） */ }
  return false;
}

// ---------- 读取（面板） ----------
const SESSION_SPAN_CAP_MS = 12 * 3600_000; // 单会话跨度上限：超过 12h 的"会话"不可信（多为文件被反复 touch）

/**
 * 区间去重叠后的**覆盖时段**（分钟）——**不能直接求和，也不能不裁剪**：本机实测
 * ① 578 个 DSH 会话区间大量重叠，直接相加得 6128h（≈256 天）；
 * ② 会话区间还会跨出统计窗口与自然日，导致"单日 81.2h"这种不可能的数字。
 * 所以：单会话 12h 上限 + 按窗口/按天裁剪 + 合并重叠区间。
 * 语义上它是"有活跃会话存在的时段"（并行 agent 会叠加到接近全天），**不等于工作时长**——面板按此措辞展示。
 * @param {Array<[number, number]>} intervals
 * @param {[number, number]} clip
 */
function unionMinutes(intervals: Array<[number, number]>, clip?: [number, number]): number {
  const [lo, hi] = clip || [-Infinity, Infinity];
  const list = intervals
    .map(([a, b]) => [Math.max(a, lo), Math.min(Math.min(b, a + SESSION_SPAN_CAP_MS), hi)] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0, curS = -1, curE = -1;
  for (const [s, e] of list) {
    if (curS < 0) { curS = s; curE = e; continue; }
    if (s <= curE) curE = Math.max(curE, e);
    else { total += curE - curS; curS = s; curE = e; }
  }
  if (curS >= 0) total += curE - curS;
  return Math.round((total / 60000) * 10) / 10;
}

/** 会话覆盖的活跃天数（去重） */
const activeDaysOf = (sessions: AgentSession[]): number =>
  new Set(sessions.map((s) => new Date(s.lastActivityAt).toISOString().slice(0, 10))).size;

/**
 * 时间线 + 投入统计（近 N 天）
 * @param {{days?: number, limit?: number}} [opts]
 */
export function getAgentTimeline({ days = 7, limit = 40 } = {}): {
  window: { days: number; since: number };
  totals: { sessions: number; minutes: number; turns: number; toolCalls: number; projects: number; activeDays: number };
  byProject: ProjectStat[];
  bySource: Array<{ source: string; sessions: number; minutes: number; toolCalls: number }>;
  topTools: Array<{ tool: string; n: number }>;
  daily: Array<{ day: string; sessions: number; minutes: number; toolCalls: number }>;
  recent: AgentSession[];
} {
  const since = Date.now() - days * 86400000;
  const rows = db.prepare(
    `SELECT id, source, session_id, project, dir, started_at, last_activity_at, ended_at, turns, tool_calls, partial
     FROM agent_sessions WHERE last_activity_at >= ? ORDER BY last_activity_at DESC`
  ).all(since) as Array<Record<string, unknown>>;

  const sessions: AgentSession[] = rows.map((r) => ({
    id: String(r.id),
    source: String(r.source),
    project: String(r.project || ""),
    dir: String(r.dir || ""),
    startedAt: Number(r.started_at) || 0,
    lastActivityAt: Number(r.last_activity_at) || 0,
    endedAt: Number(r.ended_at) || 0,
    turns: Number(r.turns) || 0,
    toolCalls: Number(r.tool_calls) || 0,
    partial: Number(r.partial) === 1,
  }));

  const byProjectMap = new Map<string, ProjectStat>();
  const bySourceMap = new Map<string, { source: string; sessions: number; minutes: number; toolCalls: number }>();
  const spansByProject = new Map<string, Array<[number, number]>>();
  const spansBySource = new Map<string, Array<[number, number]>>();
  for (const s of sessions) {
    const key = s.project || "(未命名)";
    const cur = byProjectMap.get(key) || { project: key, sources: [], sessions: 0, minutes: 0, turns: 0, toolCalls: 0, lastActivityAt: 0 };
    cur.sessions += 1;
    cur.turns += s.turns;
    cur.toolCalls += s.toolCalls;
    cur.lastActivityAt = Math.max(cur.lastActivityAt, s.lastActivityAt);
    if (!cur.sources.includes(s.source)) cur.sources.push(s.source);
    byProjectMap.set(key, cur);
    if (!spansByProject.has(key)) spansByProject.set(key, []);
    spansByProject.get(key)!.push([s.startedAt, s.lastActivityAt]);

    const src = bySourceMap.get(s.source) || { source: s.source, sessions: 0, minutes: 0, toolCalls: 0 };
    src.sessions += 1;
    src.toolCalls += s.toolCalls;
    bySourceMap.set(s.source, src);
    if (!spansBySource.has(s.source)) spansBySource.set(s.source, []);
    spansBySource.get(s.source)!.push([s.startedAt, s.lastActivityAt]);
  }
  const nowMs = Date.now();
  const windowClip: [number, number] = [since, nowMs];
  for (const [key, spans] of spansByProject) byProjectMap.get(key)!.minutes = unionMinutes(spans, windowClip);
  for (const [key, spans] of spansBySource) bySourceMap.get(key)!.minutes = unionMinutes(spans, windowClip);
  const byProject = [...byProjectMap.values()].sort((a, b) => b.minutes - a.minutes || b.toolCalls - a.toolCalls);

  const topTools = db.prepare(
    "SELECT tool, COUNT(*) AS n FROM agent_tool_events WHERE ts >= ? GROUP BY tool ORDER BY n DESC LIMIT 12"
  ).all(since) as Array<{ tool: string; n: number }>;

  const dailyMap = new Map<string, { day: string; sessions: number; toolCalls: number; spans: Array<[number, number]> }>();
  for (const s of sessions) {
    const day = new Date(s.lastActivityAt).toLocaleDateString("sv-SE"); // YYYY-MM-DD（本地）
    const cur = dailyMap.get(day) || { day, sessions: 0, toolCalls: 0, spans: [] };
    cur.sessions += 1;
    cur.toolCalls += s.toolCalls;
    cur.spans.push([s.startedAt, s.lastActivityAt]);
    dailyMap.set(day, cur);
  }
  const daily = [...dailyMap.values()]
    .sort((a, b) => (a.day < b.day ? 1 : -1))
    .slice(0, Math.max(1, Math.min(days, 60)))
    .map((d) => {
      // 按天裁剪：单日覆盖时段不可能超过 24h（否则就是跨天区间被整段算进某一天）
      const dayStart = new Date(`${d.day}T00:00:00`).getTime();
      return { day: d.day, sessions: d.sessions, minutes: unionMinutes(d.spans, [dayStart, dayStart + 86400000]), toolCalls: d.toolCalls };
    });

  const totals = {
    sessions: sessions.length,
    minutes: unionMinutes(sessions.map((s) => [s.startedAt, s.lastActivityAt] as [number, number]), windowClip),
    turns: sessions.reduce((n, s) => n + s.turns, 0),
    toolCalls: sessions.reduce((n, s) => n + s.toolCalls, 0),
    projects: byProjectMap.size,
    activeDays: activeDaysOf(sessions),
  };

  return {
    window: { days, since },
    totals,
    byProject,
    bySource: [...bySourceMap.values()].sort((a, b) => b.minutes - a.minutes),
    topTools: topTools.map((t) => ({ tool: String(t.tool), n: Number(t.n) })),
    daily,
    recent: sessions.slice(0, limit),
  };
}

// ---------- 历史回填 ----------
function listFilesRecursive(dir: string, match: (n: string) => boolean): string[] {
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

const upsertBackfill = db.prepare(`
INSERT INTO agent_sessions (id, source, session_id, project, dir, started_at, last_activity_at, ended_at, turns, tool_calls, partial, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  project = CASE WHEN excluded.project != '' THEN excluded.project ELSE agent_sessions.project END,
  dir = CASE WHEN excluded.dir != '' THEN excluded.dir ELSE agent_sessions.dir END,
  started_at = MIN(agent_sessions.started_at, excluded.started_at),
  last_activity_at = MAX(agent_sessions.last_activity_at, excluded.last_activity_at),
  ended_at = MAX(agent_sessions.ended_at, excluded.ended_at),
  turns = MAX(agent_sessions.turns, excluded.turns),
  tool_calls = MAX(agent_sessions.tool_calls, excluded.tool_calls),
  partial = MIN(agent_sessions.partial, excluded.partial),
  updated_at = excluded.updated_at
`);

/** OpenCode 历史回填（走 SQL 聚合，精确）：266 会话 / 19340 消息 / 77624 part 本机实测一次 ~1s */
export function backfillFromOpenCode(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  let oc: DatabaseSync | null = null;
  try { oc = new DatabaseSync(dbPath, { readOnly: true }); } catch { return 0; }
  try {
    const sessions = oc.prepare("SELECT id, title, directory, time_created, time_updated FROM session").all() as Array<Record<string, unknown>>;
    const turns = new Map<string, number>();
    for (const r of oc.prepare("SELECT session_id, COUNT(*) AS n FROM message GROUP BY session_id").all() as Array<Record<string, unknown>>) {
      turns.set(String(r.session_id), Number(r.n) || 0);
    }
    const tools = new Map<string, number>();
    for (const r of oc.prepare(`SELECT session_id, COUNT(*) AS n FROM part WHERE data LIKE '%"type":"tool"%' GROUP BY session_id`).all() as Array<Record<string, unknown>>) {
      tools.set(String(r.session_id), Number(r.n) || 0);
    }
    const now = Date.now();
    let n = 0;
    for (const s of sessions) {
      const sid = String(s.id);
      const created = Number(s.time_created) || 0;
      const updated = Number(s.time_updated) || created;
      if (!created) continue;
      upsertBackfill.run(
        `opencode:${sid}`, "opencode", sid,
        // 归组用 **directory 目录名**（会话 title 是"项目浏览/问候"这类临时标题，会把统计打散）；
        // 目录缺失才回落 title
        path.basename(String(s.directory || "")) || String(s.title || sid),
        String(s.directory || ""),
        created, updated, updated, turns.get(sid) || 0, tools.get(sid) || 0, 0, now,
      );
      n++;
    }
    return n;
  } catch { return 0; } finally { try { oc?.close(); } catch { /* ignore */ } }
}

/** DSH 历史回填（近似）：会话头 createdAt + 文件 mtime 当作起止，**不逐帧解压**（18.9MB/37376 帧 × 578 个太贵）→ partial=1 */
export function backfillFromDsh(dir: string, limit = 2000): { sessions: number; remaining: number } {
  const files = listFilesRecursive(dir, (n) => n === "session.jsonl.zstd");
  if (!files.length) return { sessions: 0, remaining: 0 };
  let done = 0, remaining = 0;
  const now = Date.now();
  for (const f of files) {
    if (done >= limit) { remaining++; continue; }
    let st;
    try { st = statSync(f); } catch { continue; }
    let header: { id?: string; cwd?: string; createdAt?: number } | null = null;
    try { header = readDshSessionHeader(f); } catch { /* 头部损坏（DSH 有 zstd 日志损坏历史）→ 用目录名兜底 */ }
    const sid = header?.id || path.basename(path.dirname(f));
    const project = header?.cwd ? path.basename(header.cwd) : path.basename(path.dirname(path.dirname(f))).replace(/^-+|-+$/g, "");
    const started = Number(header?.createdAt) || st.mtimeMs;
    upsertBackfill.run(`dsh:${sid}`, "dsh", sid, project, header?.cwd || "", started, st.mtimeMs, st.mtimeMs, 0, 0, 1, now);
    done++;
  }
  return { sessions: done, remaining };
}

/** Codex / Claude Code 历史回填（jsonl 行扫描：task_started/task_complete 或 assistant 行） */
export function backfillFromJsonl(dir: string, source: "codex" | "claude-code", limit = 500): number {
  const files = listFilesRecursive(dir, (n) => n.endsWith(".jsonl")).slice(0, limit);
  const now = Date.now();
  let n = 0;
  for (const f of files) {
    let text = "";
    let st;
    try { st = statSync(f); text = readFileSync(f, "utf8"); } catch { continue; }
    let turns = 0, toolCalls = 0, started = st.birthtimeMs || st.mtimeMs;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let j: Record<string, unknown>;
      try { j = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const payload = (j.payload || {}) as Record<string, unknown>;
      const ts = Date.parse(String(j.timestamp || "")) || 0;
      if (ts && ts < started) started = ts;
      const type = `${String(j.type || "")}${payload.type ? `:${String(payload.type)}` : ""}`;
      if (source === "codex") {
        if (type === "event_msg:agent_message" || (type === "response_item:message" && payload.role === "assistant")) turns++;
        else if (/function_call|local_shell_call|custom_tool_call|web_search_call/.test(type)) toolCalls++;
      } else if (type === "assistant") {
        const m = (j.message || {}) as Record<string, unknown>;
        if (m.tool_use) toolCalls++;
        else if (m.content) turns++;
      }
    }
    upsertBackfill.run(
      `${source}:${path.basename(f, ".jsonl")}`, source, path.basename(f, ".jsonl"),
      path.basename(path.dirname(f)), path.dirname(f), started, st.mtimeMs, st.mtimeMs, turns, toolCalls, 0, now,
    );
    n++;
  }
  return n;
}

/**
 * 四源历史回填（幂等；面板按钮触发）
 * @param {{opencodeDb?: string, dshDir?: string, codexDir?: string, ccDir?: string, dshLimit?: number}} [opts]
 */
export function backfillAgentSessions(opts: {
  opencodeDb?: string; dshDir?: string; codexDir?: string; ccDir?: string; dshLimit?: number;
} = {}): { opencode: number; dsh: { sessions: number; remaining: number }; codex: number; "claude-code": number; total: number } {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const opencode = backfillFromOpenCode(opts.opencodeDb || path.join(home, ".local", "share", "opencode", "opencode.db"));
  const dsh = backfillFromDsh(opts.dshDir || path.join(home, ".dsh", "sessions"), opts.dshLimit ?? 2000);
  const codex = backfillFromJsonl(opts.codexDir || path.join(home, ".codex", "sessions"), "codex");
  const cc = backfillFromJsonl(opts.ccDir || path.join(home, ".claude", "projects"), "claude-code");
  return { opencode, dsh, codex, "claude-code": cc, total: opencode + dsh.sessions + codex + cc };
}
