// trace.mjs 单测：LLM/工具调用入库 + 统计视图（临时 DB 隔离）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("trace");
const { traceLLM, traceTool, getLLMStats, getRecentTools } = await import("../lib/trace.mjs");
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
