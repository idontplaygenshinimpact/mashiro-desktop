// review 路由契约测试（TS 升级发现并修复的真实缺陷回归护栏）
// 缺陷：/api/review/feedback 与 /api/review/retry 原先把 **JSON-Schema 形状的普通对象** 传给 withContract 的
// output，而 output 必须是 zod schema（内部调 output.safeParse）→ 运行期 TypeError
// "output.safeParse is not a function" → 两条路由恒 500（隐式 any 掩盖，长期无人发现）。
// 本测试断言：两条路由真实返回 200 + 契约出参（含错题入队后的非空 retry 队列）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("review-routes");
mockLLM();

const { registerReviewRoutes } = await import("../plugins/job-hunter/routes/review.mjs");
const { review } = await import("../lib/review.mjs");
const { ReviewRetryOutput, ReviewFeedbackOutput } = await import("../lib/contracts/review.mjs");

const router = createRouter();
registerReviewRoutes(router, { getCorsOrigin: () => "*" });

// mock res（withContract 需要 destroyed/writableEnded/writeHead/write/end）
function mockRes() {
  const chunks = [];
  return {
    chunks,
    destroyed: false,
    writableEnded: false,
    status: 0,
    headers: null,
    writeHead(code, headers) { this.status = code; this.headers = headers; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() { /* no-op */ },
  };
}

// mock req：GET 无 body —— withContract 走 readBodyJson，注册监听后立刻触发 end（空 body → {}）
function mockReq(url) {
  const listeners = {};
  return {
    url,
    method: "GET",
    headers: {},
    destroyed: false,
    on(ev, fn) { listeners[ev] = fn; if (ev === "end") setImmediate(() => fn()); return this; },
    destroy() { /* no-op */ },
  };
}

function body(res) {
  const text = res.chunks.join("");
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

async function hit(pathname) {
  const entry = router.resolve(pathname, "GET");
  assert.ok(entry, `${pathname} 应已注册`);
  const res = mockRes();
  await entry.fn(mockReq(pathname), res, new URL(pathname, "http://127.0.0.1"));
  return res;
}

test("① /api/review/feedback：200 + 契约出参（不再恒 500 output.safeParse）", async () => {
  const res = await hit("/api/review/feedback");
  assert.equal(res.status, 200, `期望 200，实得 ${res.status}：${JSON.stringify(body(res))}`);
  const b = body(res);
  assert.equal(b.ok, true);
  assert.equal(typeof b.today, "number");
  assert.equal(typeof b.mastered, "number");
  assert.equal(typeof b.retry, "number");
  assert.ok(ReviewFeedbackOutput.safeParse(b).success, "出参与契约一致");
});

test("② /api/review/retry：空队列 → 200 + retry: []", async () => {
  const res = await hit("/api/review/retry");
  assert.equal(res.status, 200, `期望 200，实得 ${res.status}：${JSON.stringify(body(res))}`);
  const b = body(res);
  assert.equal(b.ok, true);
  assert.deepEqual(b.retry, []);
  assert.ok(ReviewRetryOutput.safeParse(b).success, "出参与契约一致");
});

test("③ /api/review/retry：again 卡入队 → 条目形状合契约（type/priority/lastWrongAt）", async () => {
  const card = review.addCard({ topic: "事件循环", question: "q", answer: "a", source: "t" });
  review.reviewCard(card.id, 0); // again → 入错题重练队列
  const res = await hit("/api/review/retry");
  assert.equal(res.status, 200);
  const b = body(res);
  assert.ok(Array.isArray(b.retry) && b.retry.length >= 1, "队列含 again 卡");
  assert.equal(b.retry[0].topic, "事件循环");
  assert.ok(["algo", "concept"].includes(b.retry[0].type), "type 为 algo/concept");
  assert.equal(typeof b.retry[0].lastWrongAt, "number");
  const parsed = ReviewRetryOutput.safeParse(b);
  assert.ok(parsed.success, `条目形状合契约：${JSON.stringify(parsed.error?.issues || [])}`);
});

test("④ 今日复习反馈：reviewCard 后 today/mastered 计数上升", async () => {
  const card = review.addCard({ topic: "闭包", question: "q", answer: "a", source: "t" });
  review.reviewCard(card.id, 2); // good（掌握）
  const res = await hit("/api/review/feedback");
  const b = body(res);
  assert.equal(res.status, 200);
  assert.ok(b.today >= 1, "今日复习计数");
  assert.ok(b.mastered >= 1, "掌握计数");
});
