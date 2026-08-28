// ai-compact.mjs 上下文压缩测试（纵向拆分第 1 刀：从 ai.test.mjs 223-306 平移，直连新模块）
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

setupTempDb("ai-compact");
mockLLM();
const compact = await import("../lib/ai-compact.mjs");

// ---------- compactMessages ----------
test("compactMessages 不超预算不压缩", async () => {
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const out = await compact.compactMessages(msgs);
  assert.equal(out.length, 3);
});

test("compactMessages 超预算 → 摘要注入 + 保留最近", async () => {
  setLlmResponses("这是压缩后的对话摘要，保留了知识点、用户目标和当前进度，长度必须超过二十个字符才算合格。");
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) {
    big.push({ role: "user", content: "前端面试高频考点详解内容".repeat(200) });
    big.push({ role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({ r: ["长结果".repeat(200)] }) });
  }
  const out = await compact.compactMessages(big);
  assert.ok(out.length < big.length, "消息数减少");
  assert.ok(out.some((m) => m.role === "system" && m.content.includes("此前对话摘要")), "摘要注入");
  assert.ok(out.some((m) => m.role === "tool"), "保留最近 tool 结果");
});

test("compactMessages 压缩失败 → 降级丢弃 tool 结果", async () => {
  setLlmResponses("", "", "", ""); // 3 次重试都空 → 降级
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) {
    big.push({ role: "user", content: "内容".repeat(1000) }); // 每条 ≈2000 token，总超预算
    big.push({ role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({ r: ["x".repeat(1000)] }) });
  }
  const out = await compact.compactMessages(big);
  assert.ok(out.length < big.length, "降级也减少消息");
  assert.ok(!out.some((m) => m.content.includes("此前对话摘要")), "无摘要");
});

// ---------- 压缩量化验证 ----------
test("压缩量化：token 显著减少 + 保留最近上下文", async () => {
  setLlmResponses("这是压缩后的对话摘要，保留了知识点用户目标和当前进度，长度足够超过审计阈值。");
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 10; i++) {
    big.push({ role: "user", content: "前端面试高频考点".repeat(300) }); // ≈3000 token/条
    big.push({ role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({ r: ["长结果".repeat(300)] }) });
  }
  const before = compact.bodyTokens(big.filter((m) => m.role !== "system"));
  assert.ok(before > compact.COMPACT_CONFIG.budget, "构造数据超过预算");

  const out = await compact.compactMessages(big);
  const after = compact.bodyTokens(out.filter((m) => m.role !== "system"));
  const summaryMsg = out.find((m) => m.role === "system" && m.content.includes("此前对话摘要"));
  assert.ok(summaryMsg, "摘要注入");
  assert.ok(after < before * 0.3, `压缩后 token 减少 70%+（前 ${before} → 后 ${after}）`);
  // 保留最近：out 尾部是原始最近消息（非摘要）
  const tail = out[out.length - 1];
  assert.ok(tail.content.includes("长结果"), "保留最近工具结果");
});

test("压缩参数可配置：COMPACT_BUDGET 环境变量生效", async () => {
  const prev = process.env.COMPACT_BUDGET;
  process.env.COMPACT_BUDGET = "5000";
  try {
    // config.mjs 模块级缓存——用查询参数强制重新加载验证 env 读取
    const cfg2 = await import(`../config.mjs?t=${Date.now()}`);
    assert.equal(cfg2.config.compactBudget, 5000, "config 从 env 读取");
  } finally {
    if (prev === undefined) delete process.env.COMPACT_BUDGET; else process.env.COMPACT_BUDGET = prev;
  }
});

// ---------- 压缩边界不拆散 tool_calls 配对（F14 回归） ----------
test("compactMessages 不拆散 assistant(tool_calls) 与其 tool 结果", async () => {
  setLlmResponses("这是压缩后的对话摘要，长度超过二十个字符的审计阈值，用于测试压缩流程。");
  const msgs = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "user", content: "前端面试高频考点".repeat(200) });
    msgs.push({ role: "tool", tool_call_id: `old_${i}`, content: JSON.stringify({ r: ["x".repeat(500)] }) });
  }
  // 尾部：assistant(tool_calls) + tool 结果 + 最终回答（构造 keep 边界落在 tool 上，assistant 落入被压缩段）
  msgs.push({ role: "assistant", content: "工具调用说明".repeat(600), tool_calls: [{ id: "call_1", type: "function", function: { name: "get_memory", arguments: "{}" } }] });
  msgs.push({ role: "tool", tool_call_id: "call_1", content: "工具结果" });
  msgs.push({ role: "assistant", content: "最终回答".repeat(600) });

  const out = await compact.compactMessages(msgs);
  const idxTool = out.findIndex((m) => m.role === "tool" && m.tool_call_id === "call_1");
  const idxAsst = out.findIndex((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.some((tc) => tc.id === "call_1"));
  assert.ok(idxTool >= 0, "tool 结果保留");
  assert.ok(idxAsst >= 0, "assistant(tool_calls) 保留（未被压缩掉）");
  assert.equal(idxAsst, idxTool - 1, "assistant(tool_calls) 与 tool 结果相邻");
});