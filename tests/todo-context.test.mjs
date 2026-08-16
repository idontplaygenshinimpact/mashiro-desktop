// todo 任务清单 + context-meter 上下文计量单测
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

let tmpDir;
before(() => { tmpDir = setupTempDb("todo"); });
after(() => cleanupTempDb(tmpDir));

// ---------- todo ----------
test("initTodo：建立清单 + 与已有合并去重", async () => {
  await clearAllTables();
  const { initTodo, getTodo } = await import("../lib/todo.mjs");
  const r1 = initTodo([{ content: "搜索面经" }, { content: "提炼考点" }]);
  assert.equal(r1.items.length, 2);
  // 再 init 一次：新增 + 保留已有（不重复）
  const r2 = initTodo([{ content: "搜索面经" }, { content: "生成学习清单" }]);
  assert.equal(r2.items.length, 3, "合并去重后 3 项");
  assert.deepEqual(getTodo().items.map((i) => i.content), ["搜索面经", "提炼考点", "生成学习清单"]);
});

test("updateTodoItem：按 index / 按内容标记完成；越界 error", async () => {
  await clearAllTables();
  const { initTodo, updateTodoItem, getTodo } = await import("../lib/todo.mjs");
  initTodo([{ content: "A" }, { content: "B" }]);
  const r1 = updateTodoItem({ index: 0, done: true });
  assert.equal(r1.ok, true);
  assert.equal(getTodo().items[0].done, true);
  const r2 = updateTodoItem({ content: "B", done: true });
  assert.equal(r2.ok, true);
  assert.equal(getTodo().items[1].done, true);
  const r3 = updateTodoItem({ index: 99 });
  assert.equal(r3.ok, false);
});

test("clearTodo：清空", async () => {
  await clearAllTables();
  const { initTodo, clearTodo, getTodo } = await import("../lib/todo.mjs");
  initTodo([{ content: "A" }]);
  clearTodo();
  assert.deepEqual(getTodo().items, []);
});

// ---------- context-meter ----------
test("recordContextUsage + getContextUsage：估算 tokens/消息/轮次", async () => {
  const { recordContextUsage, getContextUsage, resetContextMeter } = await import("../lib/context-meter.mjs");
  resetContextMeter();
  const msgs = [
    { role: "system", content: "你是真白" },
    { role: "user", content: "讲一下事件循环" },
  ];
  const snap = recordContextUsage(msgs, 1);
  assert.ok(snap.tokens > 0, "token 估算 > 0");
  assert.equal(snap.messages, 2);
  const u = getContextUsage();
  assert.equal(u.ok, true);
  assert.equal(u.current, snap.tokens);
  assert.equal(u.messages, 2);
  assert.equal(u.rounds, 1);
  assert.ok(u.budget > 0 && u.ratio >= 0 && u.ratio <= 100);
});

test("getContextUsage：无记录时返回零值不抛", async () => {
  const { getContextUsage, resetContextMeter } = await import("../lib/context-meter.mjs");
  resetContextMeter();
  const u = getContextUsage();
  assert.equal(u.current, 0);
  assert.equal(u.messages, 0);
});
