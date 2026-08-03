// review.mjs 单测：FSRS 复习卡调度（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("review");
const { review } = await import("../lib/review.mjs");
const { memory } = await import("../lib/memory.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  // memory 有模块级镜像，直接重置数据（不重载实例，保证与 review 内部引用一致）
  for (const t of db.prepare("SELECT topic FROM weak_points").all()) {
    memory.clearWeakPoint(t.topic);
  }
});
after(() => { cleanupTempDb(dbDir); });

test("addCard 新建卡片并持久化", () => {
  const card = review.addCard({ topic: "事件循环", question: "讲一下事件循环", answer: "答案", source: "测试" });
  assert.ok(card.id);
  assert.equal(card.topic, "事件循环");
  // 重新读（getDueCards 内部 loadCards 自 DB）
  const due = review.getDueCards();
  assert.equal(due.length, 1);
  assert.equal(due[0].topic, "事件循环");
});

test("addCard 同 topic 更新不重复建卡", () => {
  review.addCard({ topic: "闭包", question: "q1" });
  review.addCard({ topic: "闭包", question: "q2" });
  assert.equal(review.getDueCards().length, 1);
  assert.equal(review.getDueCards()[0].question, "q2");
});

test("reviewCard 不存在返回错误", () => {
  const r = review.reviewCard("nope", 0);
  assert.equal(r.ok, false);
});

test("reviewCard(0) Again：FSRS 状态更新 + 复习记录入库", () => {
  const card = review.addCard({ topic: "原型链", question: "q" });
  const r = review.reviewCard(card.id, 0);
  assert.equal(r.ok, true);
  assert.ok(r.card.fsrs.due, "due 被更新");
  const log = db.prepare("SELECT * FROM card_reviews WHERE card_id=?").get(card.id);
  assert.ok(log, "复习记录入库");
  assert.equal(log.rating, 0);
});

test("reviewCard(3) Easy：清除对应薄弱点", () => {
  memory.addWeakPoint("防抖节流", "测试");
  assert.equal(memory.getWeakPoints().length, 1);
  const card = review.addCard({ topic: "防抖节流", question: "q" });
  review.reviewCard(card.id, 3);
  assert.equal(memory.getWeakPoints().length, 0, "复习答对清除薄弱点");
});

test("reviewCard(0) Again：不清除薄弱点", () => {
  memory.addWeakPoint("深拷贝", "测试");
  const card = review.addCard({ topic: "深拷贝", question: "q" });
  review.reviewCard(card.id, 0);
  assert.equal(memory.getWeakPoints().length, 1);
});

test("getStats 统计 total/due", () => {
  review.addCard({ topic: "A", question: "q" });
  review.addCard({ topic: "B", question: "q" });
  const stats = review.getStats();
  assert.equal(stats.total, 2);
  assert.ok(stats.due >= 2, "新卡都在到期列表");
  assert.equal(typeof stats.mastered, "number");
  assert.equal(typeof stats.learning, "number");
});

test("getDailySession 返回到期卡片子集", () => {
  for (let i = 0; i < 5; i++) review.addCard({ topic: `点${i}`, question: "q" });
  const session = review.getDailySession(3);
  assert.equal(session.length, 3);
});

test("getStats 空库不崩溃", () => {
  const stats = review.getStats();
  assert.equal(stats.total, 0);
  assert.equal(stats.due, 0);
});
