// 事件总线 + 表达队列单测（Phase 事件驱动内核 W1）
import { test } from "node:test";
import assert from "node:assert/strict";

const { emitEvent, onEventDecision, enqueueExpression, drainExpressions, expressionQueueLength, clearExpressions, installInternalBridge } = await import("../lib/events.mjs");
const { onHook, clearHooks } = await import("../lib/hooks.mjs");

test.beforeEach(() => { clearHooks(); clearExpressions(); installInternalBridge(); });

test("emitEvent：统一事件形状 + 转发 hooks 生态（event:<type> 命名空间）", async () => {
  let hookEv = null;
  const off = onHook("event:cc:session_started", (p) => { hookEv = p; return null; });
  const ev = emitEvent({ type: "cc:session_started", source: "cc-watcher", payload: { session: "abc" } });
  assert.equal(ev.type, "cc:session_started");
  assert.equal(ev.source, "cc-watcher");
  assert.ok(ev.ts > 0);
  // hooks 转发是异步的（emitHook await）——等一拍
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(hookEv, "hooks 监听器收到事件");
  assert.equal(hookEv.payload.session, "abc");
  off();
});

test("emitEvent：决策层订阅收到事件（异步失败隔离）", async () => {
  const got = [];
  const off = onEventDecision((ev) => { got.push(ev.type); });
  emitEvent({ type: "chat_done", source: "agent", payload: {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(got, ["chat_done"], "决策层收到归一事件");
  off();
});

test("emitEvent：决策层抛错不影响主流程（失败隔离）", async () => {
  onEventDecision(() => { throw new Error("决策崩了"); });
  // 不应抛出
  emitEvent({ type: "x", payload: {} });
  await new Promise((r) => setTimeout(r, 10));
});

test("enqueueExpression / drainExpressions：取走即清空 + 空 text 拒绝", () => {
  assert.equal(drainExpressions().length, 0, "空队列 drain 空");
  enqueueExpression({ text: "   " }); // 空白拒绝
  assert.equal(expressionQueueLength(), 0);
  enqueueExpression({ text: "🎬 Claude Code 开跑了", scene: "agent-start", level: "bubble" });
  assert.equal(expressionQueueLength(), 1);
  const evs = drainExpressions();
  assert.equal(evs.length, 1);
  assert.equal(evs[0].text, "🎬 Claude Code 开跑了");
  assert.equal(evs[0].scene, "agent-start");
  assert.equal(expressionQueueLength(), 0, "drain 后清空");
  assert.equal(drainExpressions().length, 0, "再 drain 空");
});

test("表达队列 TTL：过期丢弃，未过期保留", () => {
  enqueueExpression({ text: "过期", ttl: 100 });
  enqueueExpression({ text: "未过期", ttl: 60000 });
  const evs = drainExpressions(Date.now() + 5000); // 模拟 5s 后 drain
  assert.equal(evs.length, 1);
  assert.equal(evs[0].text, "未过期");
});

test("表达队列上限 100：超限丢最旧", () => {
  for (let i = 0; i < 120; i++) enqueueExpression({ text: `msg${i}` });
  assert.ok(expressionQueueLength() <= 100, "队列不超 100");
  const evs = drainExpressions();
  assert.equal(evs.length, 100);
  assert.ok(!evs.some((e) => e.text === "msg0"), "最旧的被挤掉");
});

test("chat_done 内部归一：emitHook 触发总线事件（决策层可消费，默认不表达）", async () => {
  const { emitHook } = await import("../lib/hooks.mjs");
  const got = [];
  const off = onEventDecision((ev) => { if (ev.type === "chat_done") got.push(ev.payload.replyLen); });
  await emitHook("chat_done", { userMsg: "你好", reply: "回复内容" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(got.length, 1, "chat_done 归一进总线");
  assert.equal(got[0], 4, "payload 带回复长度");
  off();
});