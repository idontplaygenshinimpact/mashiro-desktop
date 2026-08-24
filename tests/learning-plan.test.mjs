// learning-plan.mjs 单测：长期学习计划引擎（计划 CRUD / 事件流 / scope 归属 / 趋势聚合）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("learning-plan");
const {
  createLearningPlan, getLearningPlans, matchPlanForTopic,
  recordLearningEvent, getLearningPlanStatus, newPlanId,
} = await import("../lib/learning-plan.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  db.prepare("DELETE FROM learning_events").run();
});
after(() => { cleanupTempDb(dbDir); });

test("createLearningPlan：必填校验 + 计划实体完整", () => {
  assert.equal(createLearningPlan({ title: "" }).ok, false, "标题必填");
  assert.equal(createLearningPlan({ title: "算法", scope: [] }).ok, false, "scope 必填（归类钥匙）");
  const r = createLearningPlan({ title: "算法专项", scope: ["二分", "链表", "DP"], quotaPerDay: 3, durationDays: 90, milestones: ["阶段1：链表", "阶段2：DP"] });
  assert.equal(r.ok, true);
  assert.ok(r.plan.id.startsWith("plan-"));
  assert.equal(r.plan.quotaPerDay, 3);
  assert.deepEqual(r.plan.scope, ["二分", "链表", "dp"], "scope 小写归一");
  assert.equal(getLearningPlans().length, 1);
});

test("事件归属：topic 命中 scope → planId；未命中 → null", () => {
  createLearningPlan({ title: "算法专项", scope: ["链表", "二分"] });
  const hit = recordLearningEvent({ topic: "反转链表（LeetCode 206）", kind: "challenge_done", result: "pass", quality: 1, durationMs: 60000 });
  assert.ok(hit.ok && hit.planId, "链表题自动归入算法计划");
  const miss = recordLearningEvent({ topic: "事件循环与微任务", kind: "challenge_done", result: "fail", quality: 0 });
  assert.equal(miss.planId, null, "未命中 scope 不归属");
  assert.equal(matchPlanForTopic("二分查找"), getLearningPlans()[0].id, "matchPlanForTopic 命中");
});

test("趋势聚合：进度/通过率/平均耗时/今日配额/薄弱主题", () => {
  createLearningPlan({ title: "算法专项", scope: ["链表"], quotaPerDay: 2 });
  const pid = getLearningPlans()[0].id;
  recordLearningEvent({ topic: "反转链表", kind: "challenge_done", result: "pass", quality: 1, durationMs: 60000, planId: pid });
  recordLearningEvent({ topic: "环形链表", kind: "challenge_done", result: "fail", quality: 0, durationMs: 180000, planId: pid });
  recordLearningEvent({ topic: "环形链表", kind: "challenge_done", result: "fail", quality: 0, durationMs: 200000, planId: pid });
  const r = getLearningPlanStatus(pid);
  assert.equal(r.ok, true);
  assert.equal(r.status.doneTotal, 3);
  assert.equal(r.status.passRate, 33); // 1/3
  assert.ok(Math.abs(r.status.avgMs - 146666) < 1000, `平均耗时约 146s，实际 ${r.status.avgMs}`);
  assert.equal(r.status.todayDone, 3);
  assert.equal(r.status.todayQuota, 2);
  assert.deepEqual(r.status.weakTopics, ["环形链表"], "薄弱主题按失败次数聚合");
  assert.equal(r.plan.title, "算法专项");
  assert.ok(r.plan.remainDays > 0);
});

test("getLearningPlanStatus：无计划 → 引导创建", () => {
  const r = getLearningPlanStatus();
  assert.equal(r.ok, false);
  assert.match(r.error, /还没有学习计划/, "引导用户在对话里创建");
});

test("无 planId 查询 → 取最近激活计划", () => {
  createLearningPlan({ title: "旧计划", scope: ["A"] });
  recordLearningEvent({ topic: "AA", kind: "manual", result: "pass", quality: 1, planId: getLearningPlans()[0].id });
  createLearningPlan({ title: "新计划", scope: ["B"] });
  const r = getLearningPlanStatus();
  assert.equal(r.plan.title, "新计划", "缺省取最近激活");
});