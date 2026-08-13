// study.mjs 单测（无 LLM 部分）：清单 CRUD / 勾选 / 复习出题（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("study");
const { getPlan, addPlanItems, checkItem, startReview } = await import("../lib/study.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

const sampleItems = [
  { topic: "事件循环与微任务", why: "高频", source: "test", verify_question: "讲一下事件循环", level: "必会" },
  { topic: "React Hooks 原理", why: "大厂爱考", source: "test", verify_question: "Hooks 为什么不能写在条件里", level: "进阶" },
];

test("addPlanItems 新增条目", () => {
  const r = addPlanItems(sampleItems);
  assert.equal(r.added, 2);
  const plan = getPlan();
  assert.equal(plan.items.length, 2);
  assert.ok(plan.date, "date 被设置");
  assert.equal(plan.items[0].topic, "事件循环与微任务");
  assert.equal(plan.items[0].level, "必会");
});

test("addPlanItems 去重（同 topic 不重复加）", () => {
  addPlanItems(sampleItems);
  const r = addPlanItems([{ topic: "事件循环与微任务", why: "x" }]);
  assert.equal(r.added, 0);
  assert.equal(getPlan().items.length, 2);
});

test("addPlanItems null/undefined topic 跳过", () => {
  // 空格/伪知识点不过滤（agent 层已先 _cleanTopic 过滤）；只跳过 falsy
  const r = addPlanItems([{ topic: null }, { topic: undefined }, { topic: "综合能力" }]);
  assert.equal(r.added, 1);
  assert.equal(getPlan().items[0].topic, "综合能力");
});

test("checkItem 勾选完成：doneAt + 自动建复习卡", async () => {
  addPlanItems(sampleItems);
  const plan = getPlan();
  const item = plan.items[0];
  const r = checkItem(item.id, true);
  assert.equal(r.ok, true);
  assert.equal(r.item.done, true);
  assert.ok(r.item.doneAt);
  // 学习闭环：自动建 FSRS 复习卡
  const { review } = await import("../lib/review.mjs");
  const due = review.getDueCards();
  assert.ok(due.some((c) => c.topic === item.topic), "勾选完成自动建复习卡");
});

test("checkItem 取消勾选", () => {
  addPlanItems(sampleItems);
  const item = getPlan().items[0];
  checkItem(item.id, true);
  const r = checkItem(item.id, false);
  assert.equal(r.item.done, false);
});

test("checkItem 不存在的 id 返回错误", () => {
  const r = checkItem("不存在", true);
  assert.equal(r.ok, false);
});

test("startReview 给未复盘项出验证题", async () => {
  addPlanItems(sampleItems);
  const r = await startReview();
  assert.equal(r.ok, true);
  assert.equal(r.questions.length, 2);
  assert.ok(r.questions[0].question.length > 0);
  assert.ok(r.questions[0].id);
});

test("startReview 全部复盘后返回错误", async () => {
  addPlanItems([sampleItems[0]]);
  // 直接置为已复盘（answerReview 正常路径在 study-llm.test 覆盖）
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET reviewed=1 WHERE topic=?").run("事件循环与微任务");
  const r = await startReview();
  assert.equal(r.ok, false);
});

test("getPlan 空库返回空清单", () => {
  const plan = getPlan();
  assert.deepEqual(plan.items, []);
  assert.equal(plan.date, "");
});

test("normalizeTopic/isSimilarTopic 相似去重（防表述漂移重复 + 层级降级）", async () => {
  const { normalizeTopic, isSimilarTopic } = await import("../lib/study.mjs");
  // 归一化：去括号内容/标点/词尾
  assert.equal(normalizeTopic("事件循环（浏览器环境）"), "事件循环", "去括号内容");
  // 相似判定：归一化后相等或互相包含
  assert.ok(isSimilarTopic(normalizeTopic("浏览器渲染机制与性能优化"), normalizeTopic("浏览器渲染性能优化")), "同知识点不同表述");
  assert.ok(isSimilarTopic(normalizeTopic("React Fiber 调度原理"), normalizeTopic("Fiber 调度机制")), "包含关系");
  assert.ok(isSimilarTopic(normalizeTopic("事件循环"), normalizeTopic("事件循环与微任务")), "包含关系");
  assert.ok(isSimilarTopic(normalizeTopic("防抖与节流原理"), normalizeTopic("防抖节流")), "词尾去除后相等");
  // 不误判：不同知识点
  assert.ok(!isSimilarTopic(normalizeTopic("深拷贝"), normalizeTopic("浅拷贝")), "深拷贝≠浅拷贝");
  assert.ok(!isSimilarTopic(normalizeTopic("防抖"), normalizeTopic("节流")), "防抖≠节流");
  assert.ok(!isSimilarTopic("", ""), "空串不相似");
});
