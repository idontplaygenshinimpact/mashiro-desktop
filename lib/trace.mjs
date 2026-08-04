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
