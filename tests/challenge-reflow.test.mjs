// 题库判题回流回归护栏（闭环清查）：
// ① 判题通过 → 自动标记完成（challenges.done=1 + 学习进度回流）
// ② 判题失败 → wrong_count+1 + 薄弱点回流 + 自动建 FSRS 复习卡
// ③ mark-wrong 如实上报（题目不存在 → 404，不再恒报"已记录"）
// ④ 题库来源复习卡（topic 带 `手写题·` 前缀）答对后能清掉题干薄弱点（key 前缀不一致曾导致永远清不掉）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("challenge-reflow");
mockLLM();

const { db } = await import("../lib/db.mjs");
const { importChallengesData, getChallenges, getChallengeDetail } = await import("../lib/ai-career.ts");
const { memory } = await import("../lib/memory.mjs");
const { review } = await import("../lib/review.mjs");
const { registerPracticeRoutes } = await import("../plugins/job-hunter/routes/practice.ts");

function mockRes() {
  const chunks = [];
  return {
    chunks, destroyed: false, writableEnded: false, status: 0,
    writeHead(code) { this.status = code; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() {},
  };
}
function mockReq(body) {
  const listeners = {};
  return {
    method: "POST", url: "/", headers: {}, destroyed: false,
    // 注册 end 监听后再回放 body：这样无论 readBody 何时挂监听，data+end 都不丢
    on(ev, fn) {
      listeners[ev] = fn;
      if (ev === "end") setImmediate(() => { if (listeners.data) listeners.data(Buffer.from(body)); fn(); });
      return this;
    },
    destroy() {},
  };
}
async function hit(router, pathname, body) {
  const entry = router.resolve(pathname, "POST");
  assert.ok(entry, `${pathname} 应已注册`);
  const req = mockReq(body);
  const res = mockRes();
  const p = entry.fn(req, res, new URL(pathname, "http://x"));
  await p;
  for (let i = 0; i < 200 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 10));
  return { status: res.status, json: (() => { try { return JSON.parse(res.chunks.join("")); } catch { return {}; } })() };
}

const router = createRouter();
registerPracticeRoutes(router);

// 题目：带判题的简单实现题
// 判题契约（lib/sandbox-worker.ts）：skeleton 里声明的函数名 → 作为参数注入 `__test__`，
// 断言走注入的 `__assert__`（失败抛错 → success=false）。这里按真实题库格式（skeleton 定名）写。
// 导入契约（lib/ai-career.ts importChallengesData）：键名是 **camelCase `testCode`**（不是 DB 列名
// `test_code`）——传错键会被静默丢弃 → test_code 落空 → 判题恒 `__test__ is not defined`。
// 下面的 roundtrip 断言把这条盯死。
importChallengesData([
  {
    id: "ch-1", title: "数组求和", category: "handwrite", difficulty: 1, description: "求和",
    skeleton: "function solution(a) {\n  // 在这里写你的实现\n}\n",
    testCode: 'async function __test__(solution) { __assert__(solution([1, 2, 3]) === 6, "数组求和"); }',
  },
  { id: "ch-missing", title: "不存在的题", category: "handwrite", difficulty: 1, description: "", skeleton: "", testCode: "" },
]);

test("判题通过 → 自动落 done（此前生产库 done 恒 0/448）", async () => {
  // 导入→详情 roundtrip：testCode 必须原样落到 challenges.test_code 并能被详情读出
  // （键名传错会静默丢用例 → 判题永远失败，这条断言就是防这个）
  const detail = getChallengeDetail("ch-1");
  assert.equal(detail?.testCode, 'async function __test__(solution) { __assert__(solution([1, 2, 3]) === 6, "数组求和"); }', "testCode 必须落库并可读回");
  const r = await hit(router, "/api/challenges/run", JSON.stringify({ id: "ch-1", userCode: "function solution(a){return a.reduce((x,y)=>x+y,0);}" }));
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true, `判题应通过：${JSON.stringify(r.json).slice(0, 160)}`);
  assert.equal(r.json.reflow?.done, true, "判题通过必须回流 done");
  const done = getChallenges({}).filter((c) => c.id === "ch-1")[0];
  assert.equal(done?.done ? 1 : 0, 1, "challenges.done 应写为 1");
});

test("判题失败 → wrong_count+1 + 薄弱点 + 自动建复习卡（练→学闭环）", async () => {
  const before = memory.getWeakPoints().filter((w) => w.topic === "数组求和").length;
  const r = await hit(router, "/api/challenges/run", JSON.stringify({ id: "ch-1", userCode: "function solution(a){return 0;}" }));
  assert.equal(r.json.success, false, "错误实现应判失败");
  assert.equal(r.json.reflow?.wrong, true, "判题失败必须回流 wrong");
  const row = db.prepare("SELECT wrong_count FROM challenges WHERE id=?").get("ch-1");
  assert.equal(Number(row.wrong_count) >= 1, true, "wrong_count 应 +1");
  const after = memory.getWeakPoints().filter((w) => w.topic === "数组求和").length;
  assert.equal(after >= before, true, "薄弱点应回流（数量不减）");
  assert.ok(review.loadCards().cards.some((c) => String(c.topic).includes("数组求和")), "应自动建复习卡");
});

test("mark-wrong 如实上报：题目不存在 → 404（不再恒报已记录）", async () => {
  const bad = await hit(router, "/api/challenges/mark-wrong", JSON.stringify({ id: "no-such-id" }));
  assert.equal(bad.status, 404, `不存在应 404，实得 ${bad.status} ${JSON.stringify(bad.json)}`);
  assert.equal(bad.json.ok, false);
  const ok = await hit(router, "/api/challenges/mark-wrong", JSON.stringify({ id: "ch-1" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.title, "数组求和");
});

test("mark-done 如实上报：题目不存在 → 404（面板据此才不报「进度 +1」）", async () => {
  const bad = await hit(router, "/api/challenges/mark-done", JSON.stringify({ id: "no-such-id" }));
  assert.equal(bad.status, 404, `不存在应 404，实得 ${bad.status} ${JSON.stringify(bad.json)}`);
  assert.equal(bad.json.ok, false);
  assert.ok(bad.json.error, "应带回错误原因");
  const ok = await hit(router, "/api/challenges/mark-done", JSON.stringify({ id: "ch-1" }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.title, "数组求和");
});

test("原生面板消费 reflow（回流结果必须在 UI 有出口，否则仍是黑箱）", async () => {
  const src = await readFile(new URL("../desktop/renderer/panel-rest.js", import.meta.url), "utf8");
  assert.match(src, /j\.reflow/, "panel-rest.js 应读取判题响应里的 reflow");
  assert.match(src, /rf\.done/, "应区分「已自动标记完成」");
  assert.match(src, /rf\.wrong/, "应区分「已记入错题/复习卡」");
  assert.match(src, /rf\.error/, "回流失败要如实显示");
});

test("题库来源复习卡答对 → 能清掉题干薄弱点（`手写题·` 前缀不再阻断）", () => {
  memory.addWeakPoint("数组求和", "手写题练习", "agent", { question: "数组求和" });
  const card = review.loadCards().cards.find((c) => String(c.topic).includes("数组求和"));
  assert.ok(card, "应有题库来源卡");
  const r = review.reviewCard(card.id, 2); // good
  assert.equal(r.ok, true);
  assert.ok(r.clearedWeak, `应报告薄弱点已消灭（实得 ${JSON.stringify(r.clearedWeak)}）`);
  assert.equal(memory.getWeakPoints().some((w) => w.topic === "数组求和"), false, "薄弱点应被清掉");
});
