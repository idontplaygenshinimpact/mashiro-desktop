// knowledge.mjs 单测：知识树匹配 + 掌握度记录（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("knowledge");
const kp = await import("../lib/knowledge.mjs");
const { KNOWLEDGE_TREE, ALL_POINTS, matchKp, recordKp, getMastery, getWeakKps } = kp;

beforeEach(async () => {
  await clearAllTables();
  // 清模块级树缓存（settings 清了但内存缓存还在，跨测试残留）
  kp.resetKnowledgeTree();
});
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

// ---------- 可配置知识树（转后端/开源整体替换） ----------
const BACKEND_TREE = [
  { id: "db", title: "数据库", difficulty: 3, points: [
    { id: "db-index", title: "索引与B+树", difficulty: 3, kws: ["索引", "b+树", "回表"] },
    { id: "db-txn", title: "事务与隔离级别", difficulty: 3, kws: ["事务", "隔离级别", "mvcc"] },
    { id: "db-sql", title: "SQL 优化", difficulty: 2, kws: ["sql", "执行计划", "慢查询"] },
  ]},
  { id: "server", title: "服务端", difficulty: 3, points: [
    { id: "srv-golang", title: "Go 并发模型", difficulty: 3, kws: ["goroutine", "channel", "协程"] },
    { id: "srv-rpc", title: "RPC 与微服务", difficulty: 3, kws: ["rpc", "微服务", "grpc"] },
  ]},
];

test("saveKnowledgeTree：自定义树保存 + matchKp 动态跟随（转后端生效）", () => {
  const r = kp.saveKnowledgeTree(BACKEND_TREE);
  assert.equal(r.ok, true);
  // matchKp 用新树的关键词（后端）
  assert.equal(matchKp("讲讲 B+树索引"), "db-index");
  assert.equal(matchKp("goroutine 协程"), "srv-golang");
  // 前端关键词不再命中（树已换）
  assert.notEqual(matchKp("事件循环"), "js-event-loop", "前端树已被替换");
  // 无 kws 的点用 title 匹配
  assert.equal(matchKp("RPC 与微服务"), "srv-rpc");
});

test("getMastery 基于自定义树（后端知识点可见）", () => {
  kp.saveKnowledgeTree(BACKEND_TREE);
  recordKp("db-index", { correct: false }); // 38 最弱
  const list = getMastery();
  assert.ok(list.some((k) => k.id === "db-index"), "后端知识点在掌握度中");
  assert.ok(!list.some((k) => k.id === "js-closure"), "前端知识点已移除");
  assert.equal(list[0].id, "db-index", "弱项在前");
});

test("saveKnowledgeTree：非法结构拒绝 + 不落库", () => {
  const bad = [
    { id: "x" }, // 缺 title/points
    { id: "y", title: "Y", points: [{ title: "无id" }] },
  ];
  const r = kp.saveKnowledgeTree(bad);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("结构非法"));
  // 非法保存后仍用默认树
  assert.equal(matchKp("事件循环"), "js-event-loop");
});

test("resetKnowledgeTree：恢复默认前端树", () => {
  kp.saveKnowledgeTree(BACKEND_TREE);
  const r = kp.resetKnowledgeTree();
  assert.equal(r.ok, true);
  assert.equal(matchKp("事件循环"), "js-event-loop", "默认树恢复");
  assert.equal(matchKp("B+树索引"), "b+树索引", "后端关键词不再命中，走动态兜底（小写归一化）");
});

test("isValidTree：结构校验函数", () => {
  assert.equal(kp.isValidTree(BACKEND_TREE), true);
  assert.equal(kp.isValidTree([]), false);
  assert.equal(kp.isValidTree(null), false);
  assert.equal(kp.isValidTree([{ id: "a", title: "A", points: [{ id: "p", title: "P", kws: "不是数组" }] }]), false, "kws 非数组拒绝");
  assert.equal(kp.isValidTree(KNOWLEDGE_TREE), true);
});
