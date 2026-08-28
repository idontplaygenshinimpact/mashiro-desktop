// 工具直测：impl-study（纵向拆分第 3 刀新增）
// 直测 toolAddStudyItems（清单反哺 + todo 挂载）/ toolCreateReviewCard（FSRS 建卡）
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("impl-study");
mockLLM();
const { toolAddStudyItems, toolCreateReviewCard, toolGetStudyPlan } = await import("../lib/tools/impl-study.mjs");

test("toolAddStudyItems：清单写入 + 自动挂 todo + 非法 level 回退必会", async () => {
  const r = await toolAddStudyItems({
    items: [
      { topic: "事件循环", why: "面试被问", level: "进阶" },
      { topic: "   ", level: "乱写" }, // 空 topic 过滤
      { topic: "防抖节流", level: "非法级别" }, // 非法 level → 必会
    ],
  });
  assert.equal(r.ok, true);
  assert.equal(r.added, 2, "只加 2 条有效知识点");
  assert.deepEqual(r.topics, ["事件循环", "防抖节流"]);
  assert.ok(Array.isArray(r.todoItems) && r.todoItems.length === 2, "todo 任务挂载");
  // 清单可见（getPlan 读同一 db）
  const plan = await toolGetStudyPlan();
  assert.ok(plan.items.some((i) => i.topic === "事件循环" && i.why === "面试被问"), "清单含新增项");
  const fb = plan.items.find((i) => i.topic === "防抖节流");
  assert.ok(fb && fb.why.includes("对话"), "非法 level 回退必会且 why 兜底");
});

test("toolAddStudyItems：空 items → 明确错误", async () => {
  const r = await toolAddStudyItems({ items: [] });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("topic 必填"), "空输入报错");
});

test("toolCreateReviewCard：建 FSRS 复习卡（topic 必填 + question 兜底）", async () => {
  const { review } = await import("../lib/review.mjs");
  const before = review.getStats().total;
  const r = await toolCreateReviewCard({ topic: "闭包与作用域", answer: "词法作用域链" });
  assert.equal(r.ok, true);
  assert.equal(r.topic, "闭包与作用域");
  assert.ok(review.getStats().total > before, "复习卡落库");
  // question 兜底：未传 question 用默认
  const cards = review.loadCards().cards;
  const c = cards.find((x) => x.topic === "闭包与作用域");
  assert.ok(c.question.includes("请完整讲讲"), "question 兜底生成");
  // 空 topic 拒绝
  const r2 = await toolCreateReviewCard({ topic: "  " });
  assert.equal(r2.ok, false);
});