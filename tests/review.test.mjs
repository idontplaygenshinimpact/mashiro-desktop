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
  // 重新读（loadCards 自 DB）
  const cards = review.loadCards().cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].topic, "事件循环");
});

test("addCard 同 topic 更新不重复建卡", () => {
  review.addCard({ topic: "闭包", question: "q1" });
  review.addCard({ topic: "闭包", question: "q2" });
  const cards = review.loadCards().cards;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].question, "q2");
});

// F3 回归：同 tick 批量建卡 id 不碰撞（旧版 `c${Date.now()}` 同毫秒重复 → INSERT OR IGNORE 丢弃后续卡）
test("multiple addCard calls in one tick all persist", () => {
  const topics = ["闭包", "事件循环", "原型链", "Promise", "防抖节流"];
  for (const t of topics) review.addCard({ topic: t, question: `讲讲${t}` });
  const cards = review.loadCards().cards;
  assert.equal(cards.length, topics.length, "5 张卡全部入库");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM review_cards").get().n, topics.length, "DB 持久化一致");
});

// F8 回归：非法 rating 归一化为 Good(2)，DB 不存脏值
test("reviewCard 非法 rating 回退 Good 且 DB 存归一化值", () => {
  memory.addWeakPoint("闭包", "测试");
  const card = review.addCard({ topic: "闭包", question: "q" });
  const r = review.reviewCard(card.id, 99);
  assert.equal(r.ok, true);
  const log = db.prepare("SELECT rating FROM card_reviews WHERE card_id=?").get(card.id);
  assert.equal(log.rating, 2, "越界 rating 归一化为 Good(2)，不存脏值 99");
  // 非法 rating 按 Good 处理（答对）→ 清除薄弱点，与合法 Good 行为一致
  assert.equal(memory.getWeakPoints().length, 0, "非法 rating 按 Good 处理清除薄弱点");
});

// F9 回归：fsrs 列损坏 → 回退空卡，不拖垮全部读取
test("loadCards：损坏 fsrs JSON 回退空卡不崩溃", () => {
  review.addCard({ topic: "正常卡", question: "q" });
  db.prepare("UPDATE review_cards SET fsrs='{corrupt' WHERE topic='正常卡'").run();
  const cards = review.loadCards().cards;
  assert.equal(cards.length, 1, "坏数据不拖垮整表读取");
  assert.ok(cards[0].fsrs && typeof cards[0].fsrs === "object", "回退为合法空卡对象");
  assert.equal(review.getStats().total, 1, "getStats 依赖 loadCards 也不崩溃");
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

test("getStats 统计 total/due（新卡有 1 天缓冲不进到期）", () => {
  review.addCard({ topic: "A", question: "q" });
  review.addCard({ topic: "B", question: "q" });
  const stats = review.getStats();
  assert.equal(stats.total, 2);
  assert.equal(stats.due, 0, "新卡创建当天不进到期队列");
  assert.equal(typeof stats.mastered, "number");
  assert.equal(typeof stats.learning, "number");
});

test("getDailySession 返回到期卡片子集（越过首复习缓冲）", async () => {
  for (let i = 0; i < 5; i++) review.addCard({ topic: `点${i}`, question: "q" });
  // 回拨创建时间到 2 天前，使其越过 1 天首复习缓冲
  db.prepare("UPDATE review_cards SET created_at = ?").run(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const session = review.getDailySession(3);
  assert.equal(session.length, 3);
});

test("getStats 空库不崩溃", () => {
  const stats = review.getStats();
  assert.equal(stats.total, 0);
  assert.equal(stats.due, 0);
});

test("getDueCards：新卡 1 天缓冲，创建超 1 天才到期", () => {
  const card = review.addCard({ topic: "新卡", question: "q" });
  // 刚创建：不进到期队列
  assert.equal(review.getDueCards().length, 0);
  // 回拨创建时间到 2 天前 → 到期
  db.prepare("UPDATE review_cards SET created_at = ? WHERE id = ?").run(Date.now() - 2 * 24 * 60 * 60 * 1000, card.id);
  const due = review.getDueCards();
  assert.equal(due.length, 1);
  assert.equal(due[0].topic, "新卡");
});

test("loadCards：history 记录复习次数", () => {
  const card = review.addCard({ topic: "闭包", question: "q" });
  assert.equal(review.loadCards().cards.find((c) => c.id === card.id).history.length, 0);
  review.reviewCard(card.id, 2); // Good
  review.reviewCard(card.id, 2); // Good
  const c2 = review.loadCards().cards.find((c) => c.id === card.id);
  assert.equal(c2.history.length, 2, "已复习 2 次");
});
