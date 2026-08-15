// 可观测性模块：记录每次 LLM 调用（模型/耗时/token/成败）+ 工具调用链
// 数据存 mianshi.db 的 trace 表，供面板"运行监控"展示与面试讲述
import { db } from "./db.mjs";

export function ensureTraceSchema() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS trace_llm (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    role TEXT NOT NULL,            -- 调用来源：agent/interview/study/ai
    model TEXT NOT NULL,
    stream INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER,
    duration_ms INTEGER,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    endpoint TEXT                  -- 实际使用的主/备端点
  );
  CREATE TABLE IF NOT EXISTS trace_tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session_id TEXT,               -- 关联的对话会话（chat）
    tool_name TEXT NOT NULL,
    args TEXT,
    ok INTEGER NOT NULL DEFAULT 1,
    error TEXT,
    duration_ms INTEGER
  );
  CREATE TABLE IF NOT EXISTS decision_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    session_id TEXT,               -- 关联的对话会话（chat）
    decision TEXT NOT NULL CHECK(decision IN ('allow','deny','auto_allow','timeout','tool_error')),
    tool_name TEXT,
    reason TEXT,                   -- 决策理由（明确拒绝/超时/异常消息，截断）
    policy_ref TEXT,               -- 命中策略引用（如 auto 分级/MCP auto 配置）
    approved_by TEXT,              -- 批准来源（如 user；拒绝/超时为 NULL）
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_decision_ts ON decision_ledger(ts);
  `);
}
ensureTraceSchema();

// 记录一次 LLM 调用
export function traceLLM({ role = "agent", model, stream = false, inputTokens = null, outputTokens = null, durationMs = null, ok = true, error = null, endpoint = null }) {
  try {
    db.prepare(`INSERT INTO trace_llm (ts, role, model, stream, input_tokens, output_tokens, duration_ms, ok, error, endpoint)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), role, model || "unknown", stream ? 1 : 0, inputTokens, outputTokens, durationMs, ok ? 1 : 0, error ? String(error).slice(0, 300) : null, endpoint);
  } catch { /* ignore */ }
}

// 记录一次工具调用
export function traceTool({ sessionId = null, toolName, args = null, ok = true, error = null, durationMs = null }) {
  try {
    db.prepare(`INSERT INTO trace_tools (ts, session_id, tool_name, args, ok, error, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), sessionId, toolName, args ? String(args).slice(0, 500) : null, ok ? 1 : 0, error ? String(error).slice(0, 200) : null, durationMs);
  } catch { /* ignore */ }
}

// 统计视图：LLM 调用汇总
export function getLLMStats() {
  const total = db.prepare("SELECT COUNT(*) n, SUM(duration_ms) d, SUM(input_tokens) i, SUM(output_tokens) o FROM trace_llm").get();
  const fail = db.prepare("SELECT COUNT(*) n FROM trace_llm WHERE ok=0").get().n;
  const recent = db.prepare("SELECT role, model, stream, input_tokens, output_tokens, duration_ms, ok, error, ts FROM trace_llm ORDER BY id DESC LIMIT 10").all();
  return {
    total: total.n || 0,
    totalDurationMs: total.d || 0,
    totalInputTokens: total.i || 0,
    totalOutputTokens: total.o || 0,
    fail,
    recent: recent.map((r) => ({ ...r, ok: !!r.ok })),
  };
}

// 最近工具调用链
/** @typedef {{ tool_name: string, args: string|null, ok: boolean, error: string|null, duration_ms: number|null, ts: number }} ToolTraceRow */
/** @returns {ToolTraceRow[]} */
export function getRecentTools(limit = 10) {
  const rows = db.prepare("SELECT tool_name, args, ok, error, duration_ms, ts FROM trace_tools ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({
    tool_name: String(r.tool_name),
    args: r.args === null || r.args === undefined ? null : String(r.args),
    ok: !!r.ok,
    error: r.error === null || r.error === undefined ? null : String(r.error),
    duration_ms: typeof r.duration_ms === "number" ? r.duration_ms : null,
    ts: typeof r.ts === "number" ? r.ts : 0,
  }));
}

// ---------- 审计/决策账本（OpenClaw 风格：metadata-only decision receipts） ----------
// 只记录决策元数据（决策类型/工具名/理由/策略引用/批准人），绝不存工具参数或内容——供审计追溯，
// 与 trace_tools（含 args）分离，避免决策账本泄露敏感入参/回填内容。

/** 记录一条工具决策（metadata only）。ledger 永不抛错（try/catch 兜底，防破坏 agent 主循环）。
 *  @param {{sessionId?: string|null, decision: 'allow'|'deny'|'auto_allow'|'timeout'|'tool_error', toolName?: string|null, reason?: string|null, policyRef?: string|null, approvedBy?: string|null}} input
 */
export function recordDecision({ sessionId = null, decision, toolName = null, reason = null, policyRef = null, approvedBy = null }) {
  try {
    const now = Date.now();
    db.prepare(`INSERT INTO decision_ledger (ts, session_id, decision, tool_name, reason, policy_ref, approved_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(now, sessionId, decision, toolName, reason ? String(reason).slice(0, 200) : null, policyRef ? String(policyRef).slice(0, 200) : null, approvedBy ? String(approvedBy).slice(0, 100) : null, now);
  } catch { /* ignore */ }
}

/** @returns {Array<{id:number, ts:number, session_id:string|null, decision:string, tool_name:string|null, reason:string|null, policy_ref:string|null, approved_by:string|null, created_at:number}>} */
export function getRecentDecisions(limit = 50) {
  const rows = db.prepare("SELECT id, ts, session_id, decision, tool_name, reason, policy_ref, approved_by, created_at FROM decision_ledger ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map((r) => ({
    id: typeof r.id === "number" ? r.id : Number(r.id),
    ts: typeof r.ts === "number" ? r.ts : 0,
    session_id: r.session_id === null || r.session_id === undefined ? null : String(r.session_id),
    decision: String(r.decision),
    tool_name: r.tool_name === null || r.tool_name === undefined ? null : String(r.tool_name),
    reason: r.reason === null || r.reason === undefined ? null : String(r.reason),
    policy_ref: r.policy_ref === null || r.policy_ref === undefined ? null : String(r.policy_ref),
    approved_by: r.approved_by === null || r.approved_by === undefined ? null : String(r.approved_by),
    created_at: typeof r.created_at === "number" ? r.created_at : 0,
  }));
}

/** 决策统计：按决策类型 + 工具名聚合。
 *  @param {{sinceTs?: number}} [opts] sinceTs 起始时间戳（毫秒），只统计此后的决策
 *  @returns {{total:number, byDecision:Record<string,number>, byTool:Record<string,number>, breakdown:Array<{decision:string, toolName:string|null, count:number}>}}
 */
export function getDecisionStats({ sinceTs = 0 } = {}) {
  const rows = db.prepare("SELECT decision, tool_name, COUNT(*) AS count FROM decision_ledger WHERE ts >= ? GROUP BY decision, tool_name").all(sinceTs ?? 0);
  const byDecision = {};
  const byTool = {};
  let total = 0;
  const breakdown = [];
  for (const r of rows) {
    const decision = String(r.decision);
    const toolName = r.tool_name === null || r.tool_name === undefined ? null : String(r.tool_name);
    const count = Number(r.count) || 0;
    total += count;
    byDecision[decision] = (byDecision[decision] || 0) + count;
    if (toolName !== null) byTool[toolName] = (byTool[toolName] || 0) + count;
    breakdown.push({ decision, toolName, count });
  }
  return { total, byDecision, byTool, breakdown };
}
