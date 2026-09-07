// review.mjs 单测：FSRS 复习卡调度（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, resetMemoryState, mockLLM, setLlmResponses, getLastMessages } from "./helpers.mjs";

const dbDir = setupTempDb("review");
mockLLM();
const { review } = await import("../lib/review.mjs");
const { memory } = await import("../lib/memory.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  // memory 有模块级镜像：整体重置（防答错回流等行为跨测试残留）
  resetMemoryState(memory);
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

// P1-9 回归：复习提交 → 学习计划事件流埋点（kind=review）+ 返回即时反馈 tip
test("reviewCard 埋点学习事件：recordLearningEvent 落库 + tip 字段", () => {
  const card = review.addCard({ topic: "异步并发控制" });
  const r = review.reviewCard(card.id, 0); // Again 答错 → fail
  assert.equal(r.ok, true);
  assert.ok("tip" in r, "返回 tip 字段（无计划时可为 null）");
  const ev = db.prepare("SELECT topic, kind, result, quality FROM learning_events WHERE kind='review'").all();
  assert.equal(ev.length, 1, "复习事件写入学习事件流");
  assert.equal(ev[0].topic, "异步并发控制");
  assert.equal(ev[0].result, "fail", "Again(0) 归一到 fail");
  assert.equal(ev[0].quality, 0);
  // 答好 → pass
  const r2 = review.reviewCard(card.id, 3); // Easy 答对 → pass
  assert.equal(r2.ok, true);
  const ev2 = db.prepare("SELECT result, quality FROM learning_events WHERE kind='review' ORDER BY id DESC LIMIT 1").get();
  assert.equal(ev2.result, "pass", "Easy(3) 归一到 pass");
  assert.equal(ev2.quality, 1);
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

test("reviewCard 答错（Again/Hard）：薄弱点 failCount 累加（闭环回流）", () => {
  memory.addWeakPoint("事件循环", "测试", "agent");
  const before = memory.getWeakPoints().find((w) => w.topic === "事件循环").failCount;
  const card = review.addCard({ topic: "事件循环", question: "讲事件循环顺序" });
  review.reviewCard(card.id, 0); // Again 答错
  const after = memory.getWeakPoints().find((w) => w.topic === "事件循环");
  assert.ok(after.failCount > before, "答错 → 薄弱点 failCount+1");
  // 答对（Good）→ 薄弱点清除
  review.reviewCard(card.id, 2);
  assert.equal(memory.getWeakPoints().find((w) => w.topic === "事件循环"), undefined, "答对清除薄弱点");
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

// ---------- 到期排序修正：按遗忘概率（memPct）升序，新卡恒排最后 ----------
function mkFsrs({ stability, elapsedDays, dueDaysAgo = 1, state = 2 }) {
  return JSON.stringify({
    due: new Date(Date.now() - dueDaysAgo * 86400000).toISOString(),
    stability, difficulty: 5, elapsed_days: elapsedDays, scheduled_days: 10,
    reps: 3, lapses: 0, state,
    last_review: new Date(Date.now() - (elapsedDays + 1) * 86400000).toISOString(),
  });
}

test("getDueCards 按遗忘概率排序：最可能忘的先复习，新卡最后", () => {
  // A：stability 10 / elapsed 5 → memPct≈e^-0.5≈60.7%
  // B：stability 5 / elapsed 4 → memPct≈e^-0.8≈44.9%（最危险 → 应最前）
  // C：新卡（state 0，memPct=null）→ 恒排最后
  const a = review.addCard({ topic: "A卡", question: "q" });
  const b = review.addCard({ topic: "B卡", question: "q" });
  review.addCard({ topic: "C新卡", question: "q" });
  db.prepare("UPDATE review_cards SET fsrs=? WHERE id=?").run(mkFsrs({ stability: 10, elapsedDays: 5 }), a.id);
  db.prepare("UPDATE review_cards SET fsrs=? WHERE id=?").run(mkFsrs({ stability: 5, elapsedDays: 4 }), b.id);
  // 全部回拨创建时间越过 1 天首复习缓冲
  db.prepare("UPDATE review_cards SET created_at = ?").run(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const due = review.getDueCards();
  assert.equal(due.length, 3);
  assert.equal(due[0].topic, "B卡", "遗忘概率最低的先复习");
  assert.equal(due[1].topic, "A卡");
  assert.equal(due[2].topic, "C新卡", "新卡（memPct=null）排最后");
  assert.ok(due[0].memPct < due[1].memPct, "memPct 升序");
});

// ---------- 错题本：答错 >=2 次进错题本 ----------
test("getWrongCards：答错 2 次进错题本，1 次不进", () => {
  const w = review.addCard({ topic: "防抖节流", question: "手写防抖" });
  const ok = review.addCard({ topic: "事件循环", question: "讲事件循环" });
  review.reviewCard(w.id, 0); // 错 1
  review.reviewCard(w.id, 1); // 错 2（Hard 也算错）
  review.reviewCard(ok.id, 0); // 错 1 次
  review.reviewCard(ok.id, 2); // 对 1 次
  const wrong = review.getWrongCards();
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].topic, "防抖节流");
  assert.equal(wrong[0].wrongCount, 2);
  assert.ok(wrong[0].lastWrongAt, "带上次错时间");
});

// ---------- 今日复习主题（复习完 → 面试检验数据源） ----------
test("getTodayReviewedTopics：今天复习过的主题去重返回", () => {
  const a = review.addCard({ topic: "闭包", question: "q" });
  const b = review.addCard({ topic: "原型链", question: "q" });
  review.reviewCard(a.id, 2);
  review.reviewCard(a.id, 3); // 同卡重复复习 → 去重
  review.reviewCard(b.id, 2);
  const topics = review.getTodayReviewedTopics();
  assert.equal(topics.length, 2);
  assert.deepEqual(topics.map((t) => t.topic).sort(), ["原型链", "闭包"].sort());
});

// ---------- 强化复习工单任务 4：补卡/多角度/每日限额/错题重练/优先级 ----------
test("强化①：ensurePlanCoverage 清单无卡条目自动补卡（多角度 question + 优先级）", async () => {
  const { ensurePlanCoverage } = await import("../lib/review.mjs");
  const { addPlanItems, getPlan } = await import("../lib/study.mjs");
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "讲事件循环", level: "必会" }]);
  // 多角度 LLM 提炼
  setLlmResponses(JSON.stringify([{ i: 0, question: "原理：为什么微任务先执行；边界：宏任务嵌套；场景：长列表更新" }]));
  const r = await ensurePlanCoverage();
  assert.ok(r.added >= 1, "补卡");
  const card = review.loadCards().cards.find((c) => c.topic === "事件循环");
  assert.ok(card, "卡存在");
  assert.ok(card.question.includes("原理"), "多角度 question（原理）");
  assert.equal(card.priority, "必会", "优先级从 level");
});

test("强化②：getDailySession 每日限额 + 优先级（必会先出）", async () => {
  const { addPlanItems } = await import("../lib/study.mjs");
  addPlanItems([{ topic: "手写防抖", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  addPlanItems([{ topic: "HTTP 缓存", why: "w", source: "s", verify_question: "q", level: "进阶" }]);
  // 造两张卡（必会 + 进阶）——直接造到期（fsrs_due=0，绕过新卡 1 天缓冲）
  review.addCard({ topic: "手写防抖", question: "q", answer: "a", source: "t", priority: "必会" });
  review.addCard({ topic: "HTTP 缓存", question: "q", answer: "a", source: "t", priority: "进阶" });
  db.prepare("UPDATE review_cards SET fsrs_due=0, created_at=?").run(Date.now() - 2 * 24 * 3600 * 1000); // 新卡缓冲（created+1天）已过
  const session = review.getDailySession(1);
  assert.equal(session.length, 1, "每日限额 1 张");
  assert.equal(session[0].topic, "手写防抖", "必会先出");
});

test("强化③：getRetryQueue 错题重练（again 卡入队）", async () => {
  const card = review.addCard({ topic: "事件循环", question: "q", answer: "a", source: "t" });
  review.reviewCard(card.id, 0); // again
  const q = review.getRetryQueue(5);
  assert.ok(q.some((r) => r.topic === "事件循环"), "again 卡入重练队列");
});

test("强化④：getReviewFeedback 今日统计", async () => {
  const card = review.addCard({ topic: "事件循环", question: "q", answer: "a", source: "t" });
  review.reviewCard(card.id, 2); // good（掌握）
  const fb = review.getReviewFeedback();
  assert.ok(fb.today >= 1, "今日复习计数");
  assert.ok(fb.mastered >= 1, "掌握计数");
});



// ---------- 复习卡强化激活工单任务 2③：接线测试（幂等 + addPlanItems 触发） ----------
test("激活①：ensurePlanCoverage 幂等（补完不再补）", async () => {
  const { ensurePlanCoverage } = await import("../lib/review.mjs");
  const { addPlanItems } = await import("../lib/study.mjs");
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  setLlmResponses(JSON.stringify([{ i: 0, question: "原理：为什么；边界：异常；场景：实际" }]));
  const r1 = await ensurePlanCoverage();
  assert.ok(r1.added >= 1, "首次补卡");
  const r2 = await ensurePlanCoverage();
  assert.equal(r2.added, 0, "幂等（补完不再补）");
});

test("激活②：addPlanItems 后自动触发补卡（新条目 → 卡）", async () => {
  const { addPlanItems, setAutoPlanCoverage } = await import("../lib/study.mjs");
  const { review } = await import("../lib/review.mjs");
  setAutoPlanCoverage(true); // 测试环境默认关闭（防测试间干扰）——本测试显式开启验证接线
  setLlmResponses(JSON.stringify([{ i: 0, question: "原理：为什么；边界：异常；场景：实际" }]));
  addPlanItems([{ topic: "手写防抖", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  await new Promise((r) => setTimeout(r, 100)); // 等 fire-and-forget 补卡
  const card = review.loadCards().cards.find((c) => c.topic === "手写防抖");
  assert.ok(card, "新条目自动补卡");
  assert.equal(card.priority, "必会", "优先级从 level");
});

test("激活③：ensurePlanCoverage 存量升级（占位 question → 多角度 + 优先级回填，幂等）", async () => {
  const { ensurePlanCoverage } = await import("../lib/review.mjs");
  const { addPlanItems } = await import("../lib/study.mjs");
  // 旧形态卡：占位 question + 默认优先级（拓展）——模拟存量数据（工单任务 2① 的 117 张旧卡）
  review.addCard({ topic: "HTTP 缓存", question: "请简述：HTTP 缓存", answer: "强缓存/协商缓存", source: "学习清单" });
  addPlanItems([{ topic: "HTTP 缓存", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  setLlmResponses(JSON.stringify([{ i: 0, question: "原理：缓存命中；边界：协商失效；场景：静态资源" }]));
  const r = await ensurePlanCoverage();
  assert.ok(r.upgraded >= 2, "优先级回填 + question 重生成");
  const card = review.loadCards().cards.find((c) => c.topic === "HTTP 缓存");
  assert.equal(card.priority, "必会", "优先级从清单 level 回填");
  assert.ok(card.question.includes("原理"), "占位 question 升级为多角度");
  // 幂等：再跑不再动、不再调 LLM
  const r2 = await ensurePlanCoverage();
  assert.equal(r2.added, 0);
  assert.equal(r2.upgraded, 0, "升级完不再动");
});

test("激活④：generateMultiAngle prompt 必须携带条目列表（防 mock 盲区回归）", async () => {
  const { ensurePlanCoverage } = await import("../lib/review.mjs");
  const { addPlanItems } = await import("../lib/study.mjs");
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  setLlmResponses(JSON.stringify([{ i: 0, question: "原理：为什么；边界：异常；场景：实际" }]));
  await ensurePlanCoverage();
  const user = getLastMessages().map((m) => m.content).join("\n");
  assert.ok(user.includes("事件循环"), "prompt 携带条目列表（此前漏拼 list——真实 LLM 不知道提炼什么，全 fallback 成占位卡）");
});
