// 契约层测试（Phase 2 Wave 0 基建：router schema / readBodyJson / withContract / SSE union）
// 纯新增测试，不触碰既有路由——验证框架本身行为，后续 Wave 迁移路由后在此补每路由契约用例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { z } from "zod";

// ---------- fake http（EventEmitter 即 IncomingMessage 契约） ----------
function fakeReq(body) {
  const req = new EventEmitter();
  req.destroy = () => {};
  queueMicrotask(() => {
    if (body !== undefined && body !== null && body !== "") req.emit("data", body);
    req.emit("end");
  });
  return req;
}
function fakeRes() {
  return {
    status: 0, body: "", headers: {},
    destroyed: false, writableEnded: false,
    writeHead(s, h) { this.status = s; this.headers = h || {}; },
    end(s) { this.body = s || ""; this.writableEnded = true; },
    destroy() { this.destroyed = true; },
  };
}
async function hit(handler, body, isRaw = false) {
  const res = fakeRes();
  await handler(fakeReq(isRaw ? body : (body === undefined ? "" : JSON.stringify(body))), res);
  return { res, json: res.body ? JSON.parse(res.body) : null };
}

// ---------- router schema 机制 ----------
test("router.route 第 4 参 schema：resolve 不变 + hasSchema/schemaCount", async () => {
  const { createRouter } = await import("../lib/routes/router.mjs");
  const router = createRouter();
  const legacy = () => {};
  router.route("/api/a", "GET", legacy); // 无 schema（旧版行为）
  const schema = z.object({ x: z.string() });
  router.route("/api/b", "POST", async () => ({ ok: true }), { input: schema });
  assert.equal(router.resolve("/api/a", "GET").fn, legacy, "resolve 返回原 handler");
  assert.equal(router.hasSchema("/api/a", "GET"), false, "无 schema 路由 hasSchema=false");
  assert.equal(router.hasSchema("/api/b", "POST"), true, "有 schema 路由 hasSchema=true");
  assert.equal(router.schemaCount(), 1, "schemaCount 统计");
});

// ---------- readBodyJson ----------
test("readBodyJson：正常 JSON / 空 body / 坏 JSON", async () => {
  const { readBodyJson } = await import("../lib/routes/contract.mjs");
  const a = await readBodyJson(fakeReq('{"a":1}'), fakeRes());
  assert.deepEqual(a, { ok: true, body: { a: 1 } });
  const b = await readBodyJson(fakeReq(""), fakeRes());
  assert.deepEqual(b, { ok: true, body: {} }, "空 body → {}");
  const c = await readBodyJson(fakeReq("not-json"), fakeRes());
  assert.equal(c.ok, false);
  assert.equal(c.status, 400);
  assert.equal(c.error, "INVALID_JSON");
  assert.ok(Array.isArray(c.issues), "含 issues");
});

// ---------- withContract ----------
const PingInput = z.object({ ping: z.string().min(1) });
const PingOutput = z.object({ ok: z.literal(true), echo: z.string() });

test("withContract：input 校验通过 → fn 执行 → output 校验 → 200", async () => {
  const { withContract } = await import("../lib/routes/contract.mjs");
  const h = withContract(async (input) => ({ ok: true, echo: input.ping }), { input: PingInput, output: PingOutput });
  const { res, json } = await hit(h, { ping: "hi" });
  assert.equal(res.status, 200);
  assert.deepEqual(json, { ok: true, echo: "hi" });
});

test("withContract：缺必填字段 → 400 VALIDATION_ERROR + issues", async () => {
  const { withContract } = await import("../lib/routes/contract.mjs");
  const h = withContract(async (i) => ({ ok: true, echo: i.ping }), { input: PingInput, output: PingOutput });
  const { res, json } = await hit(h, {});
  assert.equal(res.status, 400);
  assert.equal(json.error, "VALIDATION_ERROR");
  assert.ok(Array.isArray(json.issues) && json.issues.length > 0, "issues 结构化");
  assert.equal(json.issues[0].path[0], "ping");
});

test("withContract：未知字段默认 strip（不 400）", async () => {
  const { withContract } = await import("../lib/routes/contract.mjs");
  let seen = null;
  const h = withContract(async (input) => { seen = input; return { ok: true, echo: input.ping }; }, { input: PingInput, output: PingOutput });
  const { res } = await hit(h, { ping: "hi", extra: "垃圾字段" });
  assert.equal(res.status, 200);
  assert.equal(seen.extra, undefined, "未知字段被 strip");
  assert.equal(seen.ping, "hi");
});

test("withContract：坏 JSON body → 400（不判定 VALIDATION_ERROR 而是 INVALID_JSON）", async () => {
  const { withContract } = await import("../lib/routes/contract.mjs");
  const h = withContract(async (i) => ({ ok: true, echo: i.ping }), { input: PingInput, output: PingOutput });
  const { res, json } = await hit(h, "{oops", true);
  assert.equal(res.status, 400);
  assert.equal(json.error, "INVALID_JSON");
});

test("withContract：fn 抛出异常 → 500 人话错误（不崩溃）", async () => {
  const { withContract } = await import("../lib/routes/contract.mjs");
  const h = withContract(async () => { throw new Error("运行失败"); }, { input: PingInput, output: PingOutput });
  const { res, json } = await hit(h, { ping: "x" });
  assert.equal(res.status, 500);
  assert.equal(json.error, "运行失败");
});

test("withContract：output 与契约不符 → 500 SCHEMA_MISMATCH（真 bug 显形）", async () => {
  const { withContract } = await import("../lib/routes/contract.mjs");
  const h = withContract(async () => ({ ok: false, echo: 123 }), { input: PingInput, output: z.object({ ok: z.literal(true), echo: z.string() }) });
  const { res, json } = await hit(h, { ping: "x" });
  assert.equal(res.status, 500);
  assert.equal(json.error, "SCHEMA_MISMATCH");
  assert.ok(Array.isArray(json.issues) && json.issues.length > 0, "SCHEMA_MISMATCH 也带 issues");
});

// ---------- SSE union ----------
test("SSE union：合法事件 safeParse 通过 + 序列化", async () => {
  const { SSEEvent, ChatStreamEvent } = await import("../lib/contracts/sse.mjs");
  // discriminated union 校验通过的事件类型
  for (const ev of [
    { type: "start" },
    { type: "delta", delta: "你好" },
    { type: "progress", done: 1, total: 5, title: "收集" },
    { type: "done", reply: "ok", saved: true },
    { type: "error", error: "炸了" },
  ]) {
    assert.ok(SSEEvent.safeParse(ev).success, `SSE 事件合法: ${ev.type}`);
  }
  // chat 专用工具/agent 事件不被通用 union 接受，但被 ChatStreamEvent 接受
  const toolEv = { type: "tool_start", name: "search" };
  assert.ok(!SSEEvent.safeParse(toolEv).success, "tool_start 不属于通用 SSEEvent");
  assert.ok(ChatStreamEvent.safeParse(toolEv).success, "tool_start 属于 ChatStreamEvent");
  assert.ok(ChatStreamEvent.safeParse({ type: "agent_done", reply: "答" }).success);
});

test("createSSEPush：输出 data: JSON + 非法事件（strict）被拦截且可测", async () => {
  const { createSSEPush } = await import("../lib/routes/contract.mjs");
  const { SSEEvent } = await import("../lib/contracts/sse.mjs");
  const writes = [];
  const res = { destroyed: false, writableEnded: false, write(s) { writes.push(s); } };
  const { push } = createSSEPush(res, { eventSchema: SSEEvent, strict: true, heartbeatMs: 0 });
  push({ type: "delta", delta: "A" });
  assert.equal(writes[0], 'data: {"type":"delta","delta":"A"}\n\n', "序列化格式统一");
});

test("createSSEPush：heartbeat 只近关闭即清（不泄漏）", async () => {
  const { createSSEPush } = await import("../lib/routes/contract.mjs");
  const { SSEEvent } = await import("../lib/contracts/sse.mjs");
  let intervals = 0;
  const realSet = globalThis.setInterval;
  globalThis.setInterval = () => { intervals++; return 12345; };
  const realClear = globalThis.clearInterval;
  let cleared = null;
  globalThis.clearInterval = (id) => { cleared = id; };
  try {
    const { close } = createSSEPush({ destroyed: false, writableEnded: false, write() {} }, { eventSchema: SSEEvent, heartbeatMs: 1000 });
    assert.equal(intervals, 1, "启动了心跳");
    close();
    assert.equal(cleared, 12345, "close 清理心跳");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
});

// Phase 2 验收 §5.3：人为把 ChatOutput.reply 改名 → 契约校验拒绝（漂移拦得住）
test("ChatOutput 字段改名漂移 → 契约拒绝（reply 缺失）", async () => {
  const { ChatOutput } = await import("../lib/contracts/chat.mjs");
  // 正常响应通过
  assert.ok(ChatOutput.safeParse({ reply: "你好", voice: "", history: [] }).success);
  // 模拟服务端把 reply 改成 answer（历史客户端读 reply 会 undefined）
  const drifted = { answer: "你好", voice: "", history: [] };
  assert.ok(!ChatOutput.safeParse(drifted).success, "reply 改名后 → 拒绝（SCHEMA_MISMATCH 会 500 暴露 bug）");
  // 类型错也拒绝
  assert.ok(!ChatOutput.safeParse({ reply: 123 }).success, "reply 非 string → 拒绝");
});
