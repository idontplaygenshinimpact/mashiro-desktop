// hooks 事件系统单测：注册/触发/拦截语义/异常隔离
import { test } from "node:test";
import assert from "node:assert/strict";
import { onHook, emitHook, listHooks, clearHooks } from "../lib/hooks.mjs";

test("onHook + emitHook 基本：监听器收到 payload 并合并 event 字段", async () => {
  clearHooks();
  const got = [];
  onHook("after_tool", (p) => { got.push(p); return "r1"; });
  const results = await emitHook("after_tool", { toolName: "fetch_page", ok: true });
  assert.equal(results.length, 1);
  assert.equal(results[0], "r1");
  assert.equal(got.length, 1);
  assert.equal(got[0].toolName, "fetch_page");
  assert.equal(got[0].event, "after_tool", "payload 自动带上 event 字段");
});

test("多个监听器串行执行，返回值按注册顺序收集", async () => {
  clearHooks();
  const order = [];
  onHook("before_tool", () => { order.push(1); return null; });
  onHook("before_tool", () => { order.push(2); return { deny: true, reason: "策略拦截" }; });
  const results = await emitHook("before_tool", { toolName: "solve_question" });
  assert.deepEqual(order, [1, 2]);
  assert.equal(results[1].deny, true, "第二个监听器返回 deny 拦截语义");
  assert.equal(results[1].reason, "策略拦截");
});

test("无监听器时 emitHook 返回空数组（不抛错）", async () => {
  clearHooks();
  const results = await emitHook("no_such_event", { x: 1 });
  assert.deepEqual(results, []);
});

test("监听器抛错被隔离：不影响其他监听器与返回值", async () => {
  clearHooks();
  const seen = [];
  onHook("after_tool", () => { throw new Error("boom"); });
  onHook("after_tool", () => { seen.push("ok"); return 42; });
  const results = await emitHook("after_tool", { toolName: "x" });
  assert.deepEqual(seen, ["ok"], "第二个监听器仍执行");
  assert.deepEqual(results, [42], "抛错监听器不产生返回值");
});

test("onHook 返回取消函数：取消后不再触发", async () => {
  clearHooks();
  let n = 0;
  const off = onHook("chat_done", () => { n++; });
  await emitHook("chat_done", {});
  off();
  await emitHook("chat_done", {});
  assert.equal(n, 1);
});

test("listHooks 返回注册概览（事件 + 数量）", async () => {
  clearHooks();
  onHook("a", () => {});
  onHook("a", () => {});
  onHook("b", () => {});
  const l = listHooks();
  assert.equal(l.length, 2);
  const a = l.find((x) => x.event === "a");
  assert.equal(a.count, 2);
});

test("clearHooks 清空全部", async () => {
  clearHooks();
  onHook("a", () => "x");
  clearHooks();
  assert.deepEqual(await emitHook("a", {}), []);
});
