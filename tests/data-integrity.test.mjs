// 数据完整性工单测试：S5 判分失败不标记 / S6 addCard 失败信号 / S7 savePlan 可观测 / M12 本地日期分桶
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("data-integrity");
mockLLM();
const { localDateKey } = await import("../lib/date-utils.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

// ---------- M12：本地日期分桶（东八区 0-8 点不跨天） ----------
test("localDateKey：本地时区日期键（UTC 0 点 = 东八区 8 点，不跨天）", () => {
  // 2026-08-31T16:30:00Z = 东八区 2026-09-01 00:30（本地 9 月 1 日）
  const ts = Date.UTC(2026, 7, 31, 16, 30); // 2026-08-31 16:30 UTC
  const local = new Date(ts);
  const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}`;
  assert.equal(localDateKey(ts), expected, "与本地日历日一致");
  // UTC 口径（toISOString）在东八区 0-8 点会跨天——localDateKey 必须不等于 UTC 键
  const utcKey = new Date(ts).toISOString().slice(0, 10);
  if (local.getHours() < 8) {
    assert.notEqual(localDateKey(ts), utcKey, "东八区 0-8 点：本地键 ≠ UTC 键（修复跨天错位）");
  }
});

// ---------- S5：判分失败不标记 reviewed ----------
test("S5：判分解析失败 → 返回 ok:false 且不标记 reviewed", async () => {
  const { answerReview } = await import("../lib/study-review.mjs");
  const { addPlanItems, getPlan } = await import("../lib/study.mjs");
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "讲事件循环", level: "必会" }]);
  const item = getPlan().items[0];
  // mock LLM 返回乱码（非 JSON）→ extractJson 解析失败
  setLlmResponses("这不是 JSON 内容，是乱码文本，没有合法结构");
  const r = await answerReview([{ id: item.id, answer: "我的回答" }]);
  assert.equal(r.ok, false, "判分失败返回 ok:false");
  assert.ok(String(r.error || "").includes("解析失败"), "错误信息明确");
  // reviewed 不变（错题仍在待复盘队列）
  const after = getPlan().items.find((i) => i.id === item.id);
  assert.equal(after.reviewed, false, "不标记 reviewed（错题回流）");
});

// ---------- S6：addCard 写库失败返回失败信号 ----------
test("S6：addCard 写库失败 → 返回 {ok:false}（不静默返回成功卡）", async () => {
  const { review } = await import("../lib/review.mjs");
  // 模拟写库失败：PRAGMA query_only（读正常、写报错——loadCards 不受影响）
  const { db } = await import("../lib/db.mjs");
  db.exec("PRAGMA query_only = ON");
  try {
    const r = review.addCard({ topic: "手写防抖", question: "q", answer: "a" });
    assert.equal(r.ok, false, "写库失败返回 ok:false");
    assert.ok(String(r.error || "").includes("写库失败"), "错误信息明确");
  } finally {
    db.exec("PRAGMA query_only = OFF");
  }
  // 恢复后正常建卡（不破坏正常路径）
  const c = review.addCard({ topic: "手写防抖", question: "q", answer: "a" });
  assert.equal(c.ok, undefined, "成功路径返回卡对象（兼容现状）");
  assert.equal(c.topic, "手写防抖");
});

// ---------- S7：savePlan 失败可观测（console.error + 返回 false） ----------
test("S7：savePlan 写库失败 → 返回 false（可观测）", async () => {
  const { savePlan } = await import("../lib/study-store.mjs");
  const { db } = await import("../lib/db.mjs");
  db.exec("ALTER TABLE study_plan_items RENAME TO study_plan_items_bak");
  try {
    const r = savePlan({ date: "2026-09-01", items: [{ id: "x1", topic: "t" }] });
    assert.equal(r, false, "写库失败返回 false");
  } finally {
    db.exec("ALTER TABLE study_plan_items_bak RENAME TO study_plan_items");
  }
  // 恢复后正常保存
  const ok = savePlan({ date: "2026-09-01", items: [{ id: "x1", topic: "t" }] });
  assert.equal(ok, true, "正常路径返回 true");
});
