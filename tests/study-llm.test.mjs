// study.mjs 单测（LLM 依赖部分）：generateStudyPlan / answerReview
// mock llm.mjs 返回 OpenAI 协议对象——若代码对对象直接 .replace() 会在此暴露（回归防线）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses, getReplyText } from "./helpers.mjs";

const dbDir = setupTempDb("study-llm");
mockLLM(); // 必须在 import study 之前
const { generateStudyPlan, getPlan, addPlanItems, answerReview } = await import("../lib/study.mjs");
const { memory } = await import("../lib/memory.mjs");

beforeEach(async () => {
  await clearAllTables();
  for (const t of (memory.getWeakPoints() || []).map((w) => w.topic)) memory.clearWeakPoint(t);
});
after(() => { cleanupTempDb(dbDir); });

test("generateStudyPlan：LLM 返回代码块 JSON → 生成清单入库", async () => {
  setLlmResponses('```json\n{"items":[{"topic":"事件循环","why":"高频考点","source":"a.md","verify_question":"讲一下事件循环","level":"必会"},{"topic":"Fiber 原理","why":"大厂区分度","source":"b.md","verify_question":"Fiber 是什么","level":"进阶"}]}\n```');
  const r = await generateStudyPlan();
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].topic, "事件循环");
  assert.equal(r.items[0].level, "必会");
  // 已入库
  assert.equal(getPlan().items.length, 2);
});

test("generateStudyPlan：LLM 返回非法内容 → 报错不崩溃", async () => {
  setLlmResponses("这不是 JSON");
  const r = await generateStudyPlan();
  assert.ok(r.error, "应返回 error");
  assert.equal(r.items.length, 0);
});

test("generateStudyPlan：返回空 items → 报错", async () => {
  setLlmResponses('{"items":[]}');
  const r = await generateStudyPlan();
  assert.ok(r.error);
});

test("generateStudyPlan：level 非法值回退必会", async () => {
  setLlmResponses('{"items":[{"topic":"A","why":"w","source":"s","verify_question":"q","level":"乱写的"}]}');
  const r = await generateStudyPlan();
  assert.equal(r.items[0].level, "必会");
});

test("generateStudyPlan：不覆盖旧清单（未完成保留/已完成移除/新条目去重）", async () => {
  // 旧清单：1 条面试实录未完成 + 1 条已完成
  addPlanItems([
    { topic: "事件循环", why: "面试被问住", source: "面试实录", verify_question: "q", level: "必会" },
    { topic: "旧知识点", why: "w", source: "s", verify_question: "q", level: "必会" },
  ]);
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET done=1, done_at=? WHERE topic='旧知识点'").run(new Date().toISOString());
  // 新生成：1 条与旧重复 + 2 条全新
  setLlmResponses('{"items":[{"topic":"事件循环","why":"重复","source":"a","verify_question":"q","level":"必会"},{"topic":"新知识点1","why":"w","source":"a","verify_question":"q","level":"进阶"},{"topic":"新知识点2","why":"w","source":"b","verify_question":"q","level":"拓展"}]}');
  const r = await generateStudyPlan();
  const topics = r.items.map((i) => i.topic);
  assert.ok(topics.includes("事件循环"), "旧未完成（面试实录）保留");
  assert.ok(topics.includes("新知识点1") && topics.includes("新知识点2"), "新条目加入");
  assert.ok(!topics.includes("旧知识点"), "已完成条目移除");
  assert.equal(topics.filter((t) => t === "事件循环").length, 1, "重复 topic 只留一条");
  // 入库一致
  assert.equal(getPlan().items.length, 3);
});

test("generateStudyPlan：旧条目状态字段保留", async () => {
  addPlanItems([{ topic: "闭包", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  // 旧条目先复习过
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET reviewed=1 WHERE topic='闭包'").run();
  setLlmResponses('{"items":[{"topic":"新知识点","why":"w","source":"a","verify_question":"q","level":"必会"}]}');
  const r = await generateStudyPlan();
  const old = r.items.find((i) => i.topic === "闭包");
  assert.equal(old.reviewed, true, "旧条目复习状态保留");
});

test("answerReview：判分 + 回流薄弱点 + 标记已复盘", async () => {
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"事件循环","verdict":"错","comment":"讲得浅","reference":"要点1"}]}');
  const r = await answerReview([{ id: item.id, answer: "我的回答" }]);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].verdict, "错");
  // 薄弱点回流
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "事件循环"), "错题进入薄弱点");
  // 标记已复盘
  assert.equal(getPlan().items[0].reviewed, true);
});

test("answerReview：答对 → 已掌握", async () => {
  addPlanItems([{ topic: "闭包", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"闭包","verdict":"对","comment":"好","reference":"要点"}]}');
  await answerReview([{ id: item.id, answer: "回答" }]);
  assert.ok(memory.getMastered().some((m) => m.topic === "闭包"));
});

test("answerReview：无答案 → 错误", async () => {
  const r = await answerReview([]);
  assert.equal(r.ok, false);
});

test("answerReview：LLM 返回非法 JSON → 空结果不崩溃", async () => {
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses("完全不是 JSON");
  const r = await answerReview([{ id: item.id, answer: "回答" }]);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 0);
});

// 回归防线：getReplyText 是真实实现，若被测代码忘了用它（直接对响应对象操作）会抛错
test("回归：mock 响应是对象形态（与真实 llmChat 契约一致）", () => {
  const data = { choices: [{ message: { content: '{"x":1}' } }] };
  assert.equal(getReplyText(data), '{"x":1}');
  // 对象上调用 replace 必然抛 TypeError——上次 bug（study.mjs 对 llmChat 返回值 .replace）的形态
  assert.throws(() => data.replace(/x/g, ""), TypeError, "忘了 getReplyText 会炸");
});
