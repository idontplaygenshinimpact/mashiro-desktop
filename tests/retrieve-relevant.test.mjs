// 编排能力缺口工单 T4：相关记忆检索注入（retrieveRelevant——query 相关优先）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, resetMemoryState } from "./helpers.mjs";

const dbDir = setupTempDb("retrieve-relevant");
const { db } = await import("../lib/db.mjs");
const { memory } = await import("../lib/memory.mjs");

beforeEach(async () => {
  await clearAllTables();
  try { db.exec("DELETE FROM curated_memory;"); } catch { /* ignore */ } // clearAllTables 不含 curated_memory
  resetMemoryState(memory);
  // 造 curated 数据（含相关与无关）
  const ins = db.prepare("INSERT INTO curated_memory (id, topic, content, source_ref, importance, origin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("c1", "事件循环", "宏任务微任务执行顺序，Promise.then 属于微任务", "dream:1", 5, "agent", Date.now(), Date.now());
  ins.run("c2", "React Hooks", "链表 + 闭包，为什么不能条件调用", "dream:2", 4, "agent", Date.now(), Date.now());
  ins.run("c3", "浏览器缓存", "强缓存与协商缓存", "dream:3", 3, "agent", Date.now(), Date.now());
  ins.run("c4", "爬虫伪知识点", "不可信内容", "dream:4", 5, "untrusted", Date.now(), Date.now()); // untrusted 不注入
});
after(() => { cleanupTempDb(dbDir); });

test("T4：query 相关条目排序在无关条目前（事件循环 → 事件循环记忆优先）", async () => {
  const r = await memory.retrieveRelevant("讲讲事件循环和微任务", 8);
  assert.ok(r.length >= 1, "有相关记忆");
  assert.equal(r[0].source, "curated:事件循环", "最相关条目排第一");
  for (let i = 1; i < r.length; i++) {
    assert.ok(r[i - 1].score >= r[i].score, `分数降序（${i - 1} vs ${i}）`);
  }
});

test("T4：untrusted 薄弱点/curated 不注入（可信来源门禁）", async () => {
  // untrusted curated 已在 beforeEach 造（c4）——检索"爬虫"不应返回它
  const r = await memory.retrieveRelevant("爬虫伪知识点", 8);
  assert.ok(!r.some((x) => x.source.includes("c4") || x.text.includes("爬虫伪知识点")), "untrusted curated 不注入");
  // untrusted 薄弱点
  memory.addWeakPoint("伪知识点", "爬虫", "untrusted");
  const r2 = await memory.retrieveRelevant("伪知识点", 8);
  assert.ok(!r2.some((x) => x.source.startsWith("weak:伪知识点")), "untrusted 薄弱点不注入");
});

test("T4：薄弱点与近期对话参与检索", async () => {
  memory.addWeakPoint("防抖节流", "面试答错", "agent");
  memory.appendChat("user", "防抖和节流有什么区别", "default");
  const r = await memory.retrieveRelevant("防抖节流实现", 8);
  assert.ok(r.some((x) => x.source === "weak:防抖节流"), "薄弱点命中");
  assert.ok(r.some((x) => x.source === "chat"), "近期对话命中");
});

test("T4：空 query → 空数组；k 上限生效", async () => {
  assert.deepEqual(await memory.retrieveRelevant(""), []);
  assert.deepEqual(await memory.retrieveRelevant("  "), []);
  const r = await memory.retrieveRelevant("事件循环", 1);
  assert.ok(r.length <= 1, "k 上限生效");
});

test("T4：无相关命中 → 空数组（agent 走固定 top-8 兜底）", async () => {
  const r = await memory.retrieveRelevant("完全无关的随机内容xyzabc", 8);
  assert.equal(r.length, 0, "无命中返回空（不注入噪声）");
});
