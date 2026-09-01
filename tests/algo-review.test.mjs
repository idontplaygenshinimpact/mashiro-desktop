// 算法题复习工单测试：type 标记（检测/回填）+ 多维自评映射（mapAlgoRating）+ 概念题不受影响
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("algo-review");
const { review } = await import("../lib/review.mjs");
const { detectAlgoTopic } = await import("../lib/review.mjs");
const { mapAlgoRating } = await import("../desktop/renderer/panel-vue-review/src/useReview.js");

beforeEach(async () => {
  await clearAllTables();
  const { db } = await import("../lib/db.mjs"); // 复用临时库 db（setupTempDb 已切换）
  db.exec("DELETE FROM review_cards");
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 算法题检测 ----------
test("detectAlgoTopic：算法关键词命中（复用 study-groups 词表）", () => {
  assert.equal(detectAlgoTopic("手写防抖节流"), true, "手写 → 算法");
  assert.equal(detectAlgoTopic("两数之和（哈希表）"), true, "哈希 → 算法");
  assert.equal(detectAlgoTopic("链表反转"), true, "链表 → 算法");
  assert.equal(detectAlgoTopic("LRU 缓存机制"), true, "lru → 算法");
});

test("detectAlgoTopic：概念题不误判", () => {
  assert.equal(detectAlgoTopic("事件循环：宏任务与微任务"), false, "概念题");
  assert.equal(detectAlgoTopic("Vue 响应式原理"), false, "概念题");
  assert.equal(detectAlgoTopic("B树B+树二叉树区别"), false, "含算法词但概念比较 → 概念题");
  assert.equal(detectAlgoTopic("防抖与节流的区别"), false, "含算法词但'区别' → 概念题");
  assert.equal(detectAlgoTopic(""), false, "空串");
});

// ---------- addCard 标记 + 回填 ----------
test("addCard：算法题卡 type='algo' 写入 DB 并输出", () => {
  const c = review.addCard({ topic: "手写防抖节流", question: "实现防抖", answer: "定时器方案；边界：立即执行、取消；复杂度 O(1)" });
  assert.equal(c.type, "algo", "新算法题卡 type='algo'");
  const loaded = review.loadCards().cards.find((x) => x.topic === "手写防抖节流");
  assert.equal(loaded.type, "algo", "loadCards 输出 type='algo'");
});

test("addCard：概念题 type='concept'（现状不变）", () => {
  const c = review.addCard({ topic: "事件循环", question: "讲事件循环", answer: "宏任务微任务顺序" });
  assert.equal(c.type, "concept", "概念题 type='concept'");
  const loaded = review.loadCards().cards.find((x) => x.topic === "事件循环");
  assert.equal(loaded.type, "concept");
});

test("回填：存量无 type 卡（算法题）→ loadCards 自动标记", async () => {
  const { db } = await awaitImportDb();
  // 模拟老库数据：直接 INSERT 不带 type（默认 'concept'）
  db.prepare("INSERT INTO review_cards (id, topic, question, answer, source, fsrs, fsrs_due, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("c1", "手写深拷贝", "q", "递归方案；边界：循环引用、Symbol；复杂度 O(n)", null, "{}", 0, Date.now(), Date.now());
  const loaded = review.loadCards().cards.find((x) => x.id === "c1");
  assert.equal(loaded.type, "algo", "存量算法题卡回填为 algo");
  // 概念题存量卡保持 concept
  db.prepare("INSERT INTO review_cards (id, topic, question, answer, source, fsrs, fsrs_due, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("c2", "HTTP 缓存", "q", "强缓存协商缓存", null, "{}", 0, Date.now(), Date.now());
  const loaded2 = review.loadCards().cards.find((x) => x.id === "c2");
  assert.equal(loaded2.type, "concept", "存量概念题保持 concept");
});

function awaitImportDb() {
  // 惰性拿 db（import 放函数内避免顶层循环）
  return import("../lib/db.mjs");
}

// ---------- 多维自评映射（mapAlgoRating——前端模块导出，主项目直接 import） ----------
test("mapAlgoRating：4 组合映射正确", () => {
  assert.equal(mapAlgoRating({ idea: "是", impl: "完整", boundary: "是", complexity: "是" }), "easy", "全对 → easy");
  assert.equal(mapAlgoRating({ idea: "是", impl: "完整", boundary: "否", complexity: "是" }), "good", "边界漏 → good");
  assert.equal(mapAlgoRating({ idea: "是", impl: "完整", boundary: "是", complexity: "否" }), "good", "复杂度漏 → good");
  assert.equal(mapAlgoRating({ idea: "是", impl: "部分", boundary: "是", complexity: "是" }), "hard", "实现部分 → hard");
  assert.equal(mapAlgoRating({ idea: "否", impl: "完整", boundary: "是", complexity: "是" }), "again", "思路不对 → again");
  assert.equal(mapAlgoRating({ idea: "是", impl: "没写出", boundary: "是", complexity: "是" }), "again", "没写出 → again");
});

test("mapAlgoRating：FSRS 四级坐标兼容（映射结果可直接进 rate）", () => {
  const RATING_GRADE = { again: 0, hard: 1, good: 2, easy: 3 };
  const r = mapAlgoRating({ idea: "是", impl: "完整", boundary: "是", complexity: "是" });
  assert.equal(RATING_GRADE[r], 3, "easy → 3（与后端 Grades 坐标一致）");
});
