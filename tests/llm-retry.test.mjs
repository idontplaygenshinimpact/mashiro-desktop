// llm.mjs 空响应重试测试：网关偶发 HTTP 200 + 空 content → llmChat 应自动重试
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

setupTempDb("llm-retry"); // llmChat 内部写 trace 表，用临时库隔离
const { llmChat, getReplyText } = await import("../lib/llm.mjs");

after(() => {
  mock.restoreAll();
  cleanupTempDb(process.env.MIANSHI_DB_PATH ? process.env.MIANSHI_DB_PATH.split("test.db")[0] : undefined);
});

test("llmChat：空 content 响应自动重试成功", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (url, opts) => {
    calls++;
    if (calls === 1) {
      // 网关故障：HTTP 200 + 空 content
      return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) };
    }
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: "正常回答" } }] }) };
  });
  const data = await llmChat([{ role: "user", content: "hi" }], { maxTokens: 10 });
  assert.equal(getReplyText(data), "正常回答");
  assert.ok(calls >= 2, `应至少请求 2 次（空响应后重试），实际 ${calls} 次`);
});

test("llmChat：tool_calls 响应 content 为空不算故障（工具调用场景）", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (url, opts) => {
    calls++;
    return {
      status: 200, ok: true,
      json: async () => ({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "plan_task", arguments: "{}" } }] } }] }),
    };
  });
  const data = await llmChat([{ role: "user", content: "hi" }], { maxTokens: 10 });
  assert.equal(calls, 1, "tool_calls 响应不应重试");
  assert.ok(data.choices[0].message.tool_calls.length === 1);
});

test("llmChat：连续空响应 3 次后抛错（不无限重试）", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content: "" } }] }) };
  });
  await assert.rejects(() => llmChat([{ role: "user", content: "hi" }], { maxTokens: 10 }));
  assert.ok(calls >= 3, "至少重试 3 次后放弃");
});
