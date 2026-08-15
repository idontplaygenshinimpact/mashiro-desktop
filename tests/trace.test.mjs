// trace.mjs 单测：LLM/工具调用入库 + 统计视图（临时 DB 隔离）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("trace");
const { traceLLM, traceTool, getLLMStats, getRecentTools, recordDecision, getRecentDecisions, getDecisionStats } = await import("../lib/trace.mjs");
const { db } = await import("../lib/db.mjs");

after(() => { cleanupTempDb(dbDir); });

test("traceLLM 记录成功调用", async () => {
  await clearAllTables();
  traceLLM({ role: "agent", model: "test-model", inputTokens: 100, outputTokens: 50, durationMs: 200, ok: true, endpoint: "test" });
  const rows = db.prepare("SELECT * FROM trace_llm").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "test-model");
  assert.equal(rows[0].input_tokens, 100);
  assert.equal(rows[0].ok, 1);
});

test("traceLLM 记录失败调用", async () => {
  await clearAllTables();
  traceLLM({ role: "interview", model: "m", ok: false, error: "boom" });
  const rows = db.prepare("SELECT * FROM trace_llm").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ok, 0);
  assert.equal(rows[0].error, "boom");
});

test("traceTool 记录 + getRecentTools 返回最近", async () => {
  await clearAllTables();
  for (let i = 0; i < 5; i++) traceTool({ toolName: `tool_${i}`, args: { i }, ok: true, durationMs: 10 });
  const recent = getRecentTools();
  assert.equal(recent.length, 5);
  assert.equal(recent[0].tool_name, "tool_4"); // 最新在前（id DESC）
});

test("getLLMStats 汇总计数/token", async () => {
  await clearAllTables();
  traceLLM({ role: "agent", model: "m", inputTokens: 10, outputTokens: 5, ok: true });
  traceLLM({ role: "agent", model: "m", inputTokens: 20, outputTokens: 15, ok: true });
  traceLLM({ role: "agent", model: "m", ok: false });
  const stats = getLLMStats();
  assert.equal(stats.total, 3);
  assert.equal(stats.fail, 1);
  assert.equal(stats.totalInputTokens, 30);
  assert.equal(stats.totalOutputTokens, 20);
});

// ---------- 决策账本（decision_ledger） ----------
test("recordDecision 持久化 + getRecentDecisions 最新在前", async () => {
  await clearAllTables();
  recordDecision({ sessionId: "s1", decision: "allow", toolName: "solve_question", reason: "用户批准", approvedBy: "user" });
  recordDecision({ sessionId: "s1", decision: "deny", toolName: "solve_question", reason: "用户拒绝" });
  recordDecision({ sessionId: "s2", decision: "auto_allow", toolName: "search_posts", policyRef: "auto" });
  const recent = getRecentDecisions(10);
  assert.equal(recent.length, 3);
  assert.equal(recent[0].decision, "auto_allow", "最新在前（id DESC）");
  assert.equal(recent[2].decision, "allow", "最旧在后");
  assert.equal(recent[0].tool_name, "search_posts");
  assert.equal(recent[0].policy_ref, "auto");
  assert.equal(recent[2].approved_by, "user", "allow 记录批准人");
  assert.equal(recent[1].approved_by, null, "deny 无批准人");
  assert.equal(recent[1].session_id, "s1");
  assert.ok(recent.every((d) => typeof d.id === "number" && typeof d.ts === "number" && typeof d.created_at === "number"), "含时间戳/自增 id");
});

test("getDecisionStats 按 decision + tool 聚合", async () => {
  await clearAllTables();
  recordDecision({ decision: "allow", toolName: "solve_question" });
  recordDecision({ decision: "allow", toolName: "record_interview_topics" });
  recordDecision({ decision: "deny", toolName: "solve_question" });
  recordDecision({ decision: "tool_error", toolName: "solve_question" });
  const stats = getDecisionStats({ sinceTs: 0 });
  assert.equal(stats.total, 4);
  assert.equal(stats.byDecision.allow, 2);
  assert.equal(stats.byDecision.deny, 1);
  assert.equal(stats.byDecision.tool_error, 1);
  assert.equal(stats.byTool.solve_question, 3, "solve_question 三种决策累计");
  assert.equal(stats.byTool.record_interview_topics, 1);
  assert.equal(stats.breakdown.length, 4);
  assert.ok(stats.breakdown.some((b) => b.decision === "allow" && b.toolName === "solve_question" && b.count === 1));
});

test("getDecisionStats sinceTs 过滤旧记录", async () => {
  await clearAllTables();
  recordDecision({ decision: "allow", toolName: "t" });
  const future = getDecisionStats({ sinceTs: Date.now() + 1000 });
  assert.equal(future.total, 0, "未来截止线 → 0 条");
  const all = getDecisionStats({ sinceTs: 0 });
  assert.equal(all.total, 1);
});

test("decision_ledger 元数据 only：无 content/args 列", async () => {
  const cols = db.prepare("PRAGMA table_info(decision_ledger)").all();
  const names = cols.map((c) => c.name);
  for (const banned of ["content", "args", "tool_args", "tool_content", "input", "output", "result", "payload"]) {
    assert.ok(!names.includes(banned), `不应存在列: ${banned}`);
  }
  // 决策账本只存元数据列
  assert.ok(names.includes("decision") && names.includes("tool_name") && names.includes("reason") && names.includes("policy_ref") && names.includes("approved_by"));
});

test("recordDecision 非法 decision 被 CHECK 约束拦截（不写库、不抛错）", async () => {
  await clearAllTables();
  recordDecision({ decision: "not_a_valid_decision", toolName: "t" }); // 应被 try/catch 吞掉
  assert.equal(db.prepare("SELECT COUNT(*) n FROM decision_ledger").get().n, 0, "非法 decision 不落库");
});
