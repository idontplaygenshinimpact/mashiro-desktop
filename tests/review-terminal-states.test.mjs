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

// ---------- /api/review/add：priority 不再丢 + 写库失败不再假成功 ----------
test("POST /api/review/add：priority 透传到落盘（此前路由层丢弃，一律落「拓展」）", async () => {
  const { createRouter } = await import("../lib/routes/router.mjs");
  const { registerReviewRoutes } = await import("../plugins/job-hunter/routes/review.ts");
  const router = createRouter();
  registerReviewRoutes(router);
  const entry = router.resolve("/api/review/add", "POST");
  assert.ok(entry, "路由已注册");
  const res = mockJsonRes();
  await entry.fn(mockBodyReq({ topic: "手写深拷贝", question: "实现深拷贝", source: "测试", priority: "必会" }), res, new URL("/api/review/add", "http://x"));
  const j = JSON.parse(res.chunks.join(""));
  assert.equal(res.status, 200, JSON.stringify(j));
  assert.equal(j.ok, true);
  const card = review.loadCards().cards.find((c) => c.topic === "手写深拷贝");
  assert.equal(card?.priority, "必会", "priority 必须落盘（调度按优先级排序）");
  // 非法优先级被契约挡在门外（400，而不是静默降级）
  const bad = mockJsonRes();
  await entry.fn(mockBodyReq({ topic: "手写深拷贝2", priority: "最高" }), bad, new URL("/api/review/add", "http://x"));
  assert.equal(bad.status, 400, "非法 priority 应被契约拒绝");
});

test("POST /api/review/add：写库失败不再假成功（原实现无条件 ok:true，把错误对象当 card 回给前端）", async () => {
  const { createRouter } = await import("../lib/routes/router.mjs");
  const { registerReviewRoutes } = await import("../plugins/job-hunter/routes/review.ts");
  const router = createRouter();
  registerReviewRoutes(router);
  const entry = router.resolve("/api/review/add", "POST");
  // 制造写库失败：把 review_cards 表改名（addCard 的 INSERT 会抛错 → 返回 {ok:false,error}）
  const { db } = await import("../lib/db.mjs");
  db.exec("ALTER TABLE review_cards RENAME TO review_cards_bak");
  try {
    const res = mockJsonRes();
    await entry.fn(mockBodyReq({ topic: "写库失败用例", question: "q" }), res, new URL("/api/review/add", "http://x"));
    const j = JSON.parse(res.chunks.join(""));
    assert.notEqual(res.status, 200, "写库失败不得回 200");
    assert.notEqual(j.ok, true, `不得假成功，实得 ${JSON.stringify(j)}`);
    assert.ok(j.error, "应带回错误原因");
  } finally {
    db.exec("ALTER TABLE review_cards_bak RENAME TO review_cards");
  }
});

function mockJsonRes() {
  const chunks = [];
  return {
    chunks, destroyed: false, writableEnded: false, status: 0,
    writeHead(code) { this.status = code; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() {},
  };
}
function mockBodyReq(body) {
  const listeners = {};
  return {
    method: "POST", url: "/", headers: {}, destroyed: false,
    on(ev, fn) {
      listeners[ev] = fn;
      if (ev === "end") setImmediate(() => { if (listeners.data) listeners.data(Buffer.from(JSON.stringify(body))); fn(); });
      return this;
    },
    destroy() {},
  };
}
