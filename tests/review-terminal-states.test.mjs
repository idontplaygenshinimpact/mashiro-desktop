// 复习终态回归护栏（闭环清查）：错题本门槛与重练队列终态
// 背景：① 错题本 SQL 曾排除"首刷那次答错" → 门槛被抬成"要错 ≥3 次"，生产库无卡达标 → 面板恒空；
//       ② 重练队列只看窗口内出现过 rating<2、不看最近一次 → 错→错→对 之后仍挂在队列（retry 恒 1）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("review-terminal");
mockLLM();

const { review } = await import("../lib/review.mjs");

test("错题本：同一张卡答错 2 次（含首刷那次）即入本，计数如实", () => {
  const card = review.addCard({ topic: "手写防抖 debounce", question: "写一个防抖", answer: "timer", source: "t" });
  review.reviewCard(card.id, 0); // 首刷答错
  let book = review.getWrongCards(20);
  assert.equal(book.some((c) => c.id === card.id), false, "只错 1 次不进错题本");
  review.reviewCard(card.id, 0); // 第二次答错
  book = review.getWrongCards(20);
  const hit = book.find((c) => c.id === card.id);
  assert.ok(hit, "答错 2 次应进错题本（此前被 is_first 过滤掉 → 恒空）");
  assert.equal(hit.wrongCount, 2, "错次如实计 2");
});

test("重练队列：最近一次答对后必须出队（错→错→对 的终态）", () => {
  const card = review.addCard({ topic: "事件循环与微任务", question: "讲讲微任务", answer: "queueMicrotask", source: "t" });
  review.reviewCard(card.id, 0);
  assert.ok(review.getRetryQueue(20).some((r) => r.id === card.id), "答错 → 入重练队列");
  review.reviewCard(card.id, 0);
  assert.ok(review.getRetryQueue(20).some((r) => r.id === card.id), "再次答错 → 仍在队列");
  review.reviewCard(card.id, 2); // good：最近一次已答对
  assert.equal(review.getRetryQueue(20).some((r) => r.id === card.id), false, "最近一次答对 → 出队（此前会永久滞留）");
  assert.equal(review.getReviewFeedback().retry >= 0, true, "反馈计数可读");
});
