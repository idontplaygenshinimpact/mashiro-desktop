// today-brief.mjs 单测：今日任务聚合（计划配额/到期卡/薄弱点/清单未完成）+ 播报文案
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, resetMemoryState } from "./helpers.mjs";

const dbDir = setupTempDb("today-brief");
const { buildTodayBrief, buildBriefText } = await import("../lib/today-brief.mjs");
const { db } = await import("../lib/db.mjs");
const { memory } = await import("../lib/memory.mjs");
const { review } = await import("../lib/review.mjs");

beforeEach(async () => {
  await clearAllTables();
  resetMemoryState(memory);
  db.prepare("DELETE FROM learning_events").run();
});
after(() => { cleanupTempDb(dbDir); });

test("buildTodayBrief：无计划/无任务 → 兜底文案（不崩）", () => {
  const b = buildTodayBrief();
  assert.equal(b.ok, true);
  assert.equal(b.plan.hasPlan, false);
  assert.equal(b.reviewDue, 0);
  assert.equal(b.weakCount, 0);
  assert.match(b.text, /没有到期任务/, "全空兜底");
});

test("buildTodayBrief：聚合计划配额/到期卡/薄弱点/清单未完成", async () => {
  const { createLearningPlan, recordLearningEvent, getLearningPlans } = await import("../lib/learning-plan.mjs");
  const { addPlanItems } = await import("../lib/study.mjs");
  // 计划：今天完成 1/3
  await createLearningPlan({ title: "算法专项提升", scope: ["链表"], quotaPerDay: 3, durationDays: 30 });
  const pid = getLearningPlans()[0].id;
  recordLearningEvent({ topic: "反转链表", kind: "challenge_done", result: "pass", quality: 1, planId: pid });
  // 到期卡（创建 2 天前 → 到期）
  review.addCard({ topic: "事件循环", question: "q", answer: "a", source: "t" });
  db.prepare("UPDATE review_cards SET created_at = ?").run(Date.now() - 2 * 24 * 3600 * 1000);
  // 薄弱点 + 清单未完成
  memory.addWeakPoint("闭包", "模拟面试");
  addPlanItems([{ topic: "HTTP 缓存", why: "w", source: "s", level: "必会" }]);
  const b = buildTodayBrief();
  assert.equal(b.plan.hasPlan, true);
  assert.equal(b.plan.todayDone, 1);
  assert.equal(b.plan.todayQuota, 3);
  assert.ok(b.reviewDue >= 1, "到期卡计入");
  assert.ok(b.weakCount >= 1, "薄弱点计入");
  assert.ok(b.planTodo >= 1, "清单未完成计入");
  assert.match(b.text, /今日任务/);
  assert.match(b.text, /还有 2 个单元/, "配额剩余");
  assert.match(b.text, /复习卡到期/);
  assert.match(b.text, /薄弱点/);
  assert.match(b.text, /模拟面试/, "面试建议");
});

test("buildBriefText：全空兜底 + 部分数据文案", () => {
  assert.match(buildBriefText({}), /没有到期任务/);
  const t = buildBriefText({ plan: { hasPlan: true, todayDone: 2, todayQuota: 3 }, reviewDue: 5, weakCount: 3 });
  assert.match(t, /还有 1 个单元/);
  assert.match(t, /复习卡到期 5 张/);
  assert.match(t, /薄弱点 3 个待消灭/);
  const done = buildBriefText({ plan: { hasPlan: true, todayDone: 3, todayQuota: 3 } });
  assert.match(done, /今天计划已完成/, "配额完成文案");
});
