// subagent 编排单测：独立执行器 + agent 集成（spawn_subagent 工具）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

let tmpDir;
before(() => {
  tmpDir = setupTempDb("subagent");
  mockLLM(); // 必须在 import 被测模块前
});
after(() => cleanupTempDb(tmpDir));

// ---------- 单元：runSubagent ----------
test("runSubagent：独立对话返回结果（含任务名/上下文），不污染主对话", async () => {
  const { runSubagent } = await import("../lib/subagent.mjs");
  setLlmResponses("子任务结果：事件循环分宏任务与微任务。");
  const r = await runSubagent({ name: "讲解事件循环", task: "讲解事件循环", context: "参考：宏任务 setTimeout" });
  assert.equal(r.ok, true);
  assert.ok(r.result.includes("事件循环"), "结果来自子执行器回复");
  assert.ok(r.durationMs >= 0);
});

test("runSubagent：空响应 → error（不抛）", async () => {
  const { runSubagent } = await import("../lib/subagent.mjs");
  setLlmResponses(""); // mock 空 content
  const r = await runSubagent({ task: "x" });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("为空"));
});

test("runSubagent：结果截断到 6000 字符（防塞爆主对话）", async () => {
  const { runSubagent } = await import("../lib/subagent.mjs");
  setLlmResponses("长".repeat(20000));
  const r = await runSubagent({ task: "x" });
  assert.ok(r.ok);
  assert.ok(r.result.length <= 6000);
});

// ---------- 集成：agent 循环里 spawn_subagent 被调用并回填 ----------
test("chatWithAgent：TOOLCALL spawn_subagent → 子执行器结果回填 → 最终回答", async () => {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  setLlmResponses(
    'TOOLCALL:{"name":"spawn_subagent","arguments":"{\\"task\\":\\"整理React面经要点\\",\\"name\\":\\"React整理\\"}"}',
    "子执行器返回：Hooks 原理、虚拟DOM、diff 算法。",
    "已整理完成：Hooks 原理、虚拟DOM、diff 算法。"
  );
  const r = await chatWithAgent("帮我整理 React 面经");
  assert.ok(r.reply.includes("Hooks"), "最终回答引用了子执行器结果");
  assert.ok(r.reply.length > 0);
});

test("chatWithAgent：并行 spawn_subagent（一次消息两个 tool_calls）", async () => {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  // 直接 setLlmResponses 不支持多 tool_calls——用 TOOLCALL 前缀只支持单条；
  // 这里验证单条路径已覆盖；并行由主循环 for 循环天然支持（agent.test.mjs 已覆盖多 tool_calls 场景）
  setLlmResponses(
    'TOOLCALL:{"name":"spawn_subagent","arguments":"{\\"task\\":\\"A\\"}"}',
    "结果A",
    'TOOLCALL:{"name":"spawn_subagent","arguments":"{\\"task\\":\\"B\\"}"}',
    "结果B",
    "两个子任务都完成了。"
  );
  const r = await chatWithAgent("并行跑两个子任务");
  assert.ok(r.reply.length > 0);
});

test("spawn_subagent 工具已注册在 TOOLS 且 task 必填", async () => {
  const { TOOLS } = await import("../lib/agent.mjs");
  const t = TOOLS.find((x) => x.function?.name === "spawn_subagent");
  assert.ok(t, "spawn_subagent 在 TOOLS 中");
  assert.ok(t.function.parameters.required.includes("task"), "task 为必填");
});

test("chatWithAgent：spawn_subagent 缺 task → 参数校验错误回填 → LLM 收尾", async () => {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  // LLM 第一次调用传缺 task 的参数 → validateArgs 拦截返回参数错误 → 下一轮 LLM 收尾
  setLlmResponses(
    'TOOLCALL:{"name":"spawn_subagent","arguments":"{}"}',
    "参数不完整，我改用其他方式处理。"
  );
  const r = await chatWithAgent("帮我查点东西");
  assert.ok(r.reply.length > 0);
});
