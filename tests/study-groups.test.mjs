// study-groups.mjs 测试：大类归一化（零 mockLLM——仅临时 DB 供 knowledge 知识树，独立直测）
// 纵向拆分第 4 刀：纯函数域拆出后的零 mock 直测
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";
import { normalizeGroup } from "../lib/study-groups.mjs";

const dbDir = setupTempDb("study-groups");

test("normalizeGroup：手写/算法强信号优先于知识树泛词（手撕LRU 不再进浏览器）", () => {
  assert.equal(normalizeGroup("手撕LRU缓存"), "算法与手写", "手撕 → 算法");
  assert.equal(normalizeGroup("LRU缓存"), "算法与手写", "lru → 算法");
  assert.equal(normalizeGroup("手写防抖节流"), "算法与手写", "手写 → 算法");
  assert.equal(normalizeGroup("大厂手写 Promise.all"), "算法与手写", "大厂手写 → 算法");
});

test("normalizeGroup：知识树正常命中不被破坏（HTTP 缓存仍归浏览器原理）", () => {
  // 不含手写/手撕/lru 强信号 → 走知识树，仍是浏览器原理（防过度归类）
  assert.equal(normalizeGroup("HTTP强缓存与协商缓存"), "浏览器原理");
  assert.equal(normalizeGroup("HTTP缓存"), "浏览器原理");
});

test("normalizeGroup：兜底规则 / 其他", () => {
  assert.equal(normalizeGroup("MySQL 索引回表"), "数据库", "数据库兜底");
  assert.equal(normalizeGroup("RAG 向量检索"), "RAG与LLM", "RAG 兜底");
  assert.equal(normalizeGroup("面试自我介绍模板"), "面试与求职", "面试兜底");
  assert.equal(normalizeGroup("完全不认识的主题词xyz"), "其他", "都不中 → 其他");
});

after(() => { cleanupTempDb(dbDir); });
