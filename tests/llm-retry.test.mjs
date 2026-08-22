// llm.mjs 空响应重试测试：网关偶发 HTTP 200 + 空 content → llmChat 应自动重试
import { test, mock, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

setupTempDb("llm-retry"); // llmChat 内部写 trace 表，用临时库隔离
const { llmChat, llmChatStream, getReplyText } = await import("../lib/llm.mjs");

after(() => {
  mock.restoreAll();
  cleanupTempDb(process.env.MIANSHI_DB_PATH ? process.env.MIANSHI_DB_PATH.split("test.db")[0] : undefined);
});

test("llmChat：空 content 响应自动重试成功", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async (_url, _opts) => {
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
  mock.method(globalThis, "fetch", async (_url, _opts) => {
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

// ---------- 流式：空响应重试 / CRLF SSE / 超时存活到 body 读完（F1/F9/F10/F11 回归） ----------
function makeSseRes(chunks) {
  let i = 0;
  return {
    status: 200,
    ok: true,
    headers: { get: (k) => (k === "content-type" ? "text/event-stream" : "") },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: new TextEncoder().encode(chunks[i++]) } : { done: true, value: undefined }),
      }),
    },
  };
}

test("llmChatStream：SSE 零 delta 空流自动重试成功", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    if (calls === 1) return makeSseRes(["data: [DONE]\n\n"]); // 空流：只有结束事件
    return makeSseRes(['data: {"choices":[{"delta":{"content":"正常回答"}}]}\n\n']);
  });
  const full = await llmChatStream([{ role: "user", content: "hi" }], { maxTokens: 10 }, null);
  assert.equal(full, "正常回答");
  assert.ok(calls >= 2, "零 delta 空流应重试");
});

test("llmChatStream：非 SSE 空 content 响应自动重试", async () => {
  let calls = 0;
  mock.method(globalThis, "fetch", async () => {
    calls++;
    const headers = { get: () => "application/json" };
    if (calls === 1) return { status: 200, ok: true, headers, json: async () => ({ choices: [{ message: { content: "" } }] }) };
    return { status: 200, ok: true, headers, json: async () => ({ choices: [{ message: { content: "完整回答" } }] }) };
  });
  const full = await llmChatStream([{ role: "user", content: "hi" }], { maxTokens: 10 }, null);
  assert.equal(full, "完整回答");
  assert.ok(calls >= 2, "非 SSE 空 content 应重试");
});

test("llmChatStream：CRLF 分隔 + 末尾无空行事件都被解析", async () => {
  mock.method(globalThis, "fetch", async () => makeSseRes([
    'data: {"choices":[{"delta":{"content":"A"}}]}\r\n\r\n', // CRLF 分隔
    'data: {"choices":[{"delta":{"content":"B"}}]}\n\n',     // LF 分隔
    'data: {"choices":[{"delta":{"content":"C"}}]}',         // 末尾无空行
  ]));
  let received = "";
  const full = await llmChatStream([{ role: "user", content: "hi" }], { maxTokens: 10 }, (d) => { received += d; });
  assert.equal(full, "ABC");
  assert.equal(received, "ABC");
});

test("llmChatStream：body 读取挂起仍被超时中止，且已交付部分内容后不再重试", async () => {
  let fetchCalls = 0;
  mock.method(globalThis, "fetch", async (url, opts) => {
    fetchCalls++;
    const signal = opts?.signal;
    let sent = false;
    return {
      status: 200,
      ok: true,
      headers: { get: () => "text/event-stream" },
      body: {
        getReader: () => ({
          read: async () => {
            if (!sent) {
              sent = true;
              return { done: false, value: new TextEncoder().encode('data: {"choices":[{"delta":{"content":"部分内容"}}]}\n\n') };
            }
            if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
            await new Promise((_, reject) => {
              const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
              if (signal?.aborted) return onAbort();
              signal?.addEventListener("abort", onAbort, { once: true });
            });
          },
        }),
      },
    };
  });
  let received = "";
  await assert.rejects(
    () => llmChatStream([{ role: "user", content: "hi" }], { maxTokens: 10, timeout: 150 }, (d) => { received += d; }),
    (e) => e.name === "AbortError"
  );
  assert.equal(received, "部分内容", "已交付内容保留");
  assert.equal(fetchCalls, 1, "已交付部分内容后不再重试/切端点（避免重复交付）");
});
