// knowledge.mjs 单测：知识树匹配 + 掌握度记录（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("knowledge");
const { KNOWLEDGE_TREE, ALL_POINTS, matchKp, recordKp, getMastery, getWeakKps } = await import("../lib/knowledge.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

test("KNOWLEDGE_TREE 结构完整", () => {
  assert.ok(Array.isArray(KNOWLEDGE_TREE) && KNOWLEDGE_TREE.length >= 5);
  for (const cat of KNOWLEDGE_TREE) {
    assert.ok(cat.id && cat.title && Array.isArray(cat.points) && cat.points.length > 0);
    for (const p of cat.points) assert.ok(p.id && p.title && typeof p.difficulty === "number");
  }
  assert.equal(ALL_POINTS.length, KNOWLEDGE_TREE.reduce((n, c) => n + c.points.length, 0));
});

test("matchKp 关键词命中", () => {
  assert.equal(matchKp("事件循环与微任务"), "js-event-loop");
  assert.equal(matchKp("讲讲 setTimeout 和宏任务"), "js-event-loop");
  assert.equal(matchKp("React Hooks 原理"), "rc-hooks");
  assert.equal(matchKp("原型链"), "js-prototype");
  assert.equal(matchKp("Webpack 配置"), "eng-build");
  assert.equal(matchKp("XSS 跨域 CORS"), "br-security");
  // 兜底：无静态知识点命中 → 返回归一化后的主题自身（动态知识点）
  assert.equal(matchKp("完全不相关的内容"), "完全不相关的内容");
  assert.equal(matchKp(""), null);
  assert.equal(matchKp(null), null);
});

test("matchKp 兜底：动态主题归一化（trim/小写/截断）+ recordKp 注册进掌握度", async () => {
  // 归一化：小写 + trim
  assert.equal(matchKp("  RAG 混合检索  "), "rag 混合检索");
  // 截断到 60 字符
  const long = "x".repeat(100);
  assert.equal(matchKp(long), "x".repeat(60));
  // 动态主题写入 kp_mastery（不再永远 50）
  recordKp(matchKp("RAG 检索"), { correct: true });
  const { db } = await import("../lib/db.mjs");
  const row = db.prepare("SELECT * FROM kp_mastery WHERE topic=?").get("rag 检索");
  assert.ok(row, "动态主题注册进 kp_mastery");
  assert.equal(row.score, 58); // 50 + 8
});

test("recordKp 答对加分 / 答错扣分 / 边界", () => {
  recordKp("js-closure", { correct: true });
  recordKp("js-closure", { correct: true });
  let m = getMastery().find((k) => k.id === "js-closure");
  assert.equal(m.score, 50 + 8 + 8);
  assert.equal(m.attempts, 2);
  // 答错
  recordKp("js-closure", { correct: false });
  m = getMastery().find((k) => k.id === "js-closure");
  assert.equal(m.score, 66 - 12);
  // 上限 100
  for (let i = 0; i < 10; i++) recordKp("js-closure", { correct: true, strong: true });
  m = getMastery().find((k) => k.id === "js-closure");
  assert.equal(m.score, 100);
  // 下限 0
  for (let i = 0; i < 20; i++) recordKp("js-closure", { correct: false });
  m = getMastery().find((k) => k.id === "js-closure");
  assert.equal(m.score, 0);
});

test("recordKp 非法 kpId 不崩溃", () => {
  recordKp(null, { correct: true });
  recordKp("", { correct: false });
});

test("getMastery 未学默认 50 且弱在前排序", () => {
  recordKp("net-http", { correct: false }); // 38 分最弱
  recordKp("js-this", { correct: true });   // 58 分
  const list = getMastery();
  assert.equal(list[0].id, "net-http");
  assert.equal(list[0].score, 38);
  assert.equal(list.find((k) => k.id === "css-bfc").score, 50, "未学默认 50");
});

test("getWeakKps 只返回低于 50 的", () => {
  recordKp("css-anim", { correct: false }); // 38
  recordKp("js-this", { correct: true });   // 58
  const weak = getWeakKps(10);
  assert.ok(weak.length >= 1);
  for (const k of weak) assert.ok(k.score < 50);
  assert.ok(weak.every((k) => k.id !== "js-this"));
});
