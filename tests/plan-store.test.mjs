// 编排能力缺口工单 T1：PlanStore 计划状态机（创建/确认/推进/取消/恢复 + 门禁）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("plan-store");
const todo = await import("../lib/todo.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

test("T1：initPlan 创建计划（pending 状态 + 步骤）", () => {
  const r = todo.initPlan({ goal: "准备前端面试", steps: ["搜面经", "整理考点", "模拟面试"] });
  assert.equal(r.ok, true);
  assert.ok(r.plan.id.startsWith("plan_"), "计划 id");
  assert.equal(r.plan.status, "pending", "创建后待确认");
  assert.equal(r.plan.steps.length, 3);
  assert.equal(r.plan.currentStep, 0);
  // 持久化可恢复
  const p = todo.getPlan();
  assert.equal(p.goal, "准备前端面试");
  assert.equal(p.steps[1].title, "整理考点");
});

test("T1：initPlan 缺目标/步骤 → 拒绝", () => {
  assert.equal(todo.initPlan({ goal: "", steps: ["x"] }).ok, false);
  assert.equal(todo.initPlan({ goal: "g", steps: [] }).ok, false);
  assert.equal(todo.initPlan({ goal: "g", steps: ["  "] }).ok, false);
});

test("T1：confirmPlan 确认（pending → confirmed）", () => {
  todo.initPlan({ goal: "g", steps: ["a", "b"] });
  const r = todo.confirmPlan();
  assert.equal(r.ok, true);
  assert.equal(todo.getPlan().status, "confirmed");
  // 重复确认拒绝
  assert.equal(todo.confirmPlan().ok, false, "已确认不可重复确认");
});

test("T1：advancePlan 推进（每步 done + currentStep 后移；完成 → done）", () => {
  todo.initPlan({ goal: "g", steps: ["a", "b", "c"] });
  todo.confirmPlan();
  const r1 = todo.advancePlan();
  assert.equal(r1.ok, true);
  assert.equal(r1.done, false);
  assert.equal(todo.getPlan().steps[0].done, true, "第 1 步标记完成");
  assert.equal(todo.getPlan().currentStep, 1);
  const r2 = todo.advancePlan();
  assert.equal(r2.done, false);
  const r3 = todo.advancePlan(); // 第 3 步完成 → 全部完成
  assert.equal(r3.done, true, "全部完成");
  assert.equal(todo.getPlan().status, "done");
  // 已完成计划不可再推进
  const r4 = todo.advancePlan();
  assert.equal(r4.ok, false, "done 计划不可推进");
  // 未确认计划不可推进
  todo.initPlan({ goal: "g2", steps: ["x"] });
  assert.equal(todo.advancePlan().ok, false, "pending 计划不可推进");
});

test("T1：cancelPlan 取消（不再拦截）", () => {
  todo.initPlan({ goal: "g", steps: ["a"] });
  const r = todo.cancelPlan();
  assert.equal(r.ok, true);
  assert.equal(todo.getPlan().status, "cancelled");
});

test("T1：clearPlan 清空（新对话会话重置）", () => {
  todo.initPlan({ goal: "g", steps: ["a"] });
  todo.clearPlan();
  assert.equal(todo.getPlan(), null);
});

test("T1：planStatusText 状态文本（pending 提示确认 / confirmed 显示进度）", () => {
  todo.initPlan({ goal: "准备面试", steps: ["搜面经", "模拟面试"] });
  const pending = todo.planStatusText();
  assert.ok(pending.includes("待确认"), "pending 提示确认");
  assert.ok(pending.includes("plan_mode"), "提示调用 plan_mode");
  todo.confirmPlan();
  const confirmed = todo.planStatusText();
  assert.ok(confirmed.includes("第 1/2 步"), "显示进度");
  assert.ok(confirmed.includes("搜面经"), "显示当前步");
  todo.cancelPlan();
  assert.equal(todo.planStatusText(), "", "取消后无状态文本");
});

test("T1：initPlan 保留旧计划未完成步骤（同目标续跑）", () => {
  todo.initPlan({ goal: "g", steps: ["a", "b"] });
  todo.confirmPlan();
  todo.advancePlan(); // a done
  todo.initPlan({ goal: "g", steps: ["b", "c"] }); // 重新规划：b 未完成保留，c 追加
  const p = todo.getPlan();
  assert.equal(p.steps.length, 2, "未完成 b 保留 + 新 c");
  assert.equal(p.steps[0].title, "b");
  assert.equal(p.steps[1].title, "c");
});
