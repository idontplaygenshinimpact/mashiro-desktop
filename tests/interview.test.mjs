// interview.mjs 单测：模拟面试全流程（mock LLM + 临时 DB）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("interview");
mockLLM();
const { startInterview, submitAnswer, endInterview } = await import("../lib/interview.mjs");
const { memory } = await import("../lib/memory.mjs");

beforeEach(async () => {
  await clearAllTables();
  memory.clearInterview();
  for (const t of (memory.getWeakPoints() || []).map((w) => w.topic)) memory.clearWeakPoint(t);
});
after(() => { cleanupTempDb(dbDir); });

const FIRST_Q = '{"question":"讲讲事件循环和微任务","basis":"面经高频","dimension":"原理","criteria":"宏微任务、顺序、场景","boundary":"不涉及浏览器渲染"}';

test("startInterview 正常开启面试", async () => {
  setLlmResponses(FIRST_Q);
  const r = await startInterview({ position: "前端" });
  assert.equal(r.ok, true);
  assert.ok(r.question.includes("事件循环"));
  assert.equal(r.round, 1);
  assert.ok(memory.getInterview(), "会话已建立");
  assert.equal(memory.getInterview().position, "前端");
});

test("startInterview 已有面试进行中 → error", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const r = await startInterview({ position: "前端" });
  assert.ok(r.error, "应返回错误");
});

test("startInterview LLM 返回非法 → 兜底破冰问题", async () => {
  setLlmResponses("乱码");
  const r = await startInterview({ position: "前端" });
  assert.equal(r.ok, true);
  assert.ok(r.question.includes("介绍"), "兜底问题");
});

test("submitAnswer 无进行中面试 → error", async () => {
  const r = await submitAnswer("回答");
  assert.ok(r.error);
});

test("submitAnswer 评分 + 推进下一问", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":80,"expr":70,"depth":60,"edge":50,"reflect":40},"comment":"不错","finish":false,"next_question":"讲讲 React Fiber","next_basis":"切换新题","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r = await submitAnswer("我的回答");
  assert.equal(r.ok, true);
  assert.equal(r.finished, false);
  assert.equal(r.total, 60); // (80+70+60+50+40)/5
  assert.ok(r.question.includes("Fiber"), "下一问");
  assert.equal(memory.getInterview().rounds.length, 1);
});

test("submitAnswer 低分 + weak_topic → 薄弱点回流", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":false,"next_question":"下一问","next_basis":"追问","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"事件循环"}');
  await submitAnswer("回答");
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "事件循环"), "低分薄弱点回流");
});

test("submitAnswer 伪知识点 weak_topic 不回流", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":false,"next_question":"下一问","next_basis":"追问","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"综合能力"}');
  await submitAnswer("回答");
  assert.equal(memory.getWeakPoints().length, 0, "伪知识点不记录");
});

test("submitAnswer finish → 面试结束", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":90,"expr":90,"depth":90,"edge":90,"reflect":90},"comment":"好","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":""}');
  const r = await submitAnswer("回答");
  assert.equal(r.finished, true);
  assert.equal(memory.getInterview().finished, true);
});

test("endInterview 无面试 → error", async () => {
  const r = await endInterview();
  assert.ok(r.error);
});

test("endInterview 完整流程：报告 + 历史 + 复习卡 + 学习清单回流", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 一轮低分（暴露薄弱点）→ 结束后回流
  setLlmResponses('{"scores":{"tech":40,"expr":40,"depth":40,"edge":40,"reflect":40},"comment":"一般","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":"防抖节流"}');
  await submitAnswer("回答");
  // endInterview 调 LLM 生成报告
  setLlmResponses("## 面试复盘（前端）\n### 总体评价\n准备度中等\n### 具体短板\n防抖节流不熟");
  const r = await endInterview();
  assert.equal(r.ok, true);
  assert.ok(r.report.includes("面试复盘"));
  assert.ok(r.avg < 60);
  // 历史记录
  assert.equal(memory.getInterviewHistory().length, 1);
  // 会话清理
  assert.equal(memory.getInterview(), null);
  // 薄弱点回流 + 复习卡 + 学习清单
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "防抖节流"));
  const { review } = await import("../lib/review.mjs");
  assert.ok(review.getStats().total >= 1, "低分轮自动建复习卡");
  const { getPlan } = await import("../lib/study.mjs");
  assert.ok(getPlan().items.some((i) => i.topic === "防抖节流"), "薄弱点回流学习清单");
});

test("endInterview 无轮次直接结束", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const r = await endInterview();
  assert.equal(r.ok, true);
  assert.equal(memory.getInterview(), null);
});
