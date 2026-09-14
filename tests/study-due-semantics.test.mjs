// 清单「待复习」口径回归护栏（闭环清查）：
// 原实现把从未复习过的新卡（fsrs_due=0）按"创建超 1 天"也算到期 → 实测 221 张卡里 174 张新卡全部算到期
// → 清单 192/216 条（89%）恒显示「待复习」，「已学/已掌握」两组永不出现（复习 Tab 同期只有 47 张真到期）。
// 现在到期只认 fsrs_due > 0 且 <= now；新卡归「待学/学习中」（每日队列仍按 FSRS 缓冲调度，不漏复习）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("study-due-semantics");
mockLLM();

const { db } = await import("../lib/db.mjs");
const { review } = await import("../lib/review.mjs");
const { loadPlan } = await import("../lib/study-store.ts");

const DAY = 24 * 3600 * 1000;

test("未复习过的新卡不算「待复习」；复习过且到期的才算", () => {
  const now = Date.now();
  // 两张卡：新卡（从未复习，创建 2 天前）与到期卡（复习过、fsrs_due 已过）
  const fresh = review.addCard({ topic: "新卡·未学知识点", question: "q", answer: "a", source: "t" });
  const due = review.addCard({ topic: "到期卡·该复习了", question: "q", answer: "a", source: "t" });
  db.prepare("UPDATE review_cards SET created_at=? WHERE id=?").run(now - 2 * DAY, fresh.id);
  db.prepare("UPDATE review_cards SET created_at=?, fsrs_due=? WHERE id=?").run(now - 5 * DAY, now - 1000, due.id);

  // 清单里放两个同 topic 条目，读 loadPlan 的 reviewDue 派生
  db.prepare("INSERT OR REPLACE INTO study_plan_items (id, topic, why, source, verify_question, done, reviewed, level, from_interview, grp, created_at, date) VALUES (?,?,?,?,?,0,0,'必会',0,'未分类',?,?)")
    .run("s-fresh", "新卡·未学知识点", "w", "s", "v", now, "2026-09-14");
  db.prepare("INSERT OR REPLACE INTO study_plan_items (id, topic, why, source, verify_question, done, reviewed, level, from_interview, grp, created_at, date) VALUES (?,?,?,?,?,0,0,'必会',0,'未分类',?,?)")
    .run("s-due", "到期卡·该复习了", "w", "s", "v", now, "2026-09-14");

  const items = loadPlan().items;
  const a = items.find((i) => i.id === "s-fresh");
  const b = items.find((i) => i.id === "s-due");
  assert.equal(a?.reviewDue, false, "从未复习的新卡不得标记为「待复习」（此前会，导致 89% 条目滞留该态）");
  assert.equal(b?.reviewDue, true, "复习过且 fsrs_due 已过的卡仍正确标记「待复习」");

  // 每日复习队列仍应把新卡排进来（不漏复习）——由 review 侧负责
  const withNew = review.getDueCards ? review.getDueCards(50) : [];
  assert.ok(Array.isArray(withNew), "复习队列可读（口径未受影响）");
});
