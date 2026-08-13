// memory.mjs 单测：画像/关注点/薄弱点/已掌握/对话历史/复盘回流
// 策略：静态单例 + resetMemoryState（保持模块 URL 稳定，让 V8 coverage 全量统计）；
//       持久化验证用 freshMemory 重载实例（少数）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, resetMemoryState } from "./helpers.mjs";

const dbDir = setupTempDb("memory");
const { memory } = await import("../lib/memory.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  resetMemoryState(memory);
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 关注点 ----------
test("addInterests 去重 + trim + 持久化(DB)", () => {
  memory.addInterests(["React", "字节", "React"]);
  memory.addInterests(["  Event Loop  "]);
  assert.deepEqual(memory.getInterests(), ["React", "字节", "Event Loop"]);
  const rows = db.prepare("SELECT topic FROM interests ORDER BY added_at").all().map((r) => r.topic);
  assert.deepEqual(rows, ["React", "字节", "Event Loop"], "DB 持久化");
});

test("addInterests 空值忽略/超长截断到 30 字符", () => {
  memory.addInterests(["", "   ", "x".repeat(50)]);
  assert.deepEqual(memory.getInterests(), ["x".repeat(30)]);
});

// ---------- 已看帖子 ----------
test("markSeen/isSeen 持久化(DB)", () => {
  assert.equal(memory.isSeen("http://a"), false);
  memory.markSeen("http://a");
  assert.equal(memory.isSeen("http://a"), true);
  const row = db.prepare("SELECT url FROM seen_urls WHERE url=?").get("http://a");
  assert.ok(row, "DB 持久化");
});

test("markSeen 空值忽略", () => {
  memory.markSeen("");
  memory.markSeen(null);
  assert.equal(memory.get().seenUrls.length, 0);
});

// ---------- 对话历史 ----------
test("appendChat/getChatHistory 持久化(DB)", () => {
  memory.appendChat("user", "你好");
  memory.appendChat("assistant", "你好呀");
  const hist = memory.getChatHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, "user");
  const n = db.prepare("SELECT COUNT(*) n FROM chat_history").get().n;
  assert.equal(n, 2, "DB 持久化");
});

test("appendChat 上限 40 条", () => {
  for (let i = 0; i < 50; i++) memory.appendChat("user", `m${i}`);
  assert.equal(memory.getChatHistory().length, 40);
  assert.equal(memory.get().stats.chats, 50);
});

// ---------- 薄弱点 ----------
test("addWeakPoint 过滤伪知识点", () => {
  memory.addWeakPoint("综合能力", "复盘验证");
  memory.addWeakPoint("考察维度：深度", "复盘验证");
  memory.addWeakPoint("", "x");
  memory.addWeakPoint("事件循环", "复盘验证");
  assert.equal(memory.getWeakPoints().length, 1);
  assert.equal(memory.getWeakPoints()[0].topic, "事件循环");
});

test("addWeakPoint 同主题累加 failCount + 排序 + 上限20", () => {
  memory.addWeakPoint("A点", "s1");
  memory.addWeakPoint("A点", "s2");
  for (let i = 0; i < 25; i++) memory.addWeakPoint(`点${i}`, "s3");
  const wps = memory.getWeakPoints();
  assert.equal(wps.length, 20, "最多保留 20 条");
  assert.equal(wps[0].topic, "A点");
  assert.equal(wps[0].failCount, 2);
});

test("addWeakPoint 持久化(DB)", () => {
  memory.addWeakPoint("事件循环", "面试实录", "agent");
  const row = db.prepare("SELECT * FROM weak_points WHERE topic=?").get("事件循环");
  assert.equal(row.origin, "agent");
  assert.equal(row.fail_count, 1);
});

test("addWeakPoint 自动建复习卡（source=薄弱点，同 topic+question 去重）", async () => {
  const { review } = await import("../lib/review.mjs"); // 预热模块，保证后续动态 import 立即 resolve
  memory.addWeakPoint("事件循环", "复盘验证");
  await new Promise((r) => setImmediate(r)); // 等 fire-and-forget 复习卡创建完成
  const cards = review.loadCards().cards.filter((c) => c.topic === "事件循环");
  assert.equal(cards.length, 1, "薄弱点自动建复习卡");
  assert.equal(cards[0].source, "薄弱点");
  assert.equal(cards[0].question, "事件循环", "无原题时 question 回退 topic");
  // 再次记录同主题：不重复建卡（同 topic+question）
  memory.addWeakPoint("事件循环", "复盘验证");
  await new Promise((r) => setImmediate(r));
  assert.equal(review.loadCards().cards.filter((c) => c.topic === "事件循环").length, 1, "同 topic+question 去重");
});

test("addWeakPoint 带原题/答案的复习卡", async () => {
  const { review } = await import("../lib/review.mjs");
  memory.addWeakPoint("防抖节流", "模拟面试", "agent", { question: "讲讲防抖", answer: "闭包定时器" });
  await new Promise((r) => setImmediate(r));
  const card = review.loadCards().cards.find((c) => c.topic === "防抖节流");
  assert.ok(card, "薄弱点自动建复习卡");
  assert.equal(card.question, "讲讲防抖");
  assert.equal(card.answer, "闭包定时器");
});

test("getTrustedWeakPoints 过滤 untrusted", () => {
  memory.addWeakPoint("可信点", "x", "agent");
  memory.addWeakPoint("不可信点", "x", "untrusted");
  assert.deepEqual(memory.getTrustedWeakPoints().map((w) => w.topic), ["可信点"]);
});

test("_cleanTopic 长度/模式过滤", () => {
  assert.equal(memory._cleanTopic("这是一个超过三十个字符的知识点名字用来测试过滤逻辑是否正常工作的例子"), null);
  assert.equal(memory._cleanTopic("整体表现"), null);
  assert.equal(memory._cleanTopic("暂无"), null);
  assert.equal(memory._cleanTopic("none"), null);
  assert.equal(memory._cleanTopic("  React Hooks 原理  "), "React Hooks 原理");
});

test("clearWeakPoint", () => {
  memory.addWeakPoint("A点", "x");
  memory.clearWeakPoint("A点");
  assert.equal(memory.getWeakPoints().length, 0);
});

// ---------- 复盘回流 ----------
test("applyReviewResults：错→薄弱点，答对→已掌握并清薄弱点", () => {
  memory.addWeakPoint("闭包", "旧");
  memory.applyReviewResults([
    { topic: "闭包", verdict: "对" },
    { topic: "事件循环", verdict: "错" },
    { topic: "综合能力", verdict: "错" },
    { topic: "原型链", verdict: "部分对" },
  ]);
  assert.deepEqual(memory.getMastered().map((m) => m.topic), ["闭包"]);
  const weak = memory.getWeakPoints().map((w) => w.topic).sort();
  assert.deepEqual(weak, ["事件循环", "原型链"]);
  assert.equal(memory.getWeakPoints().some((w) => w.topic === "闭包"), false);
});

test("applyReviewResults 空结果不崩溃", () => {
  memory.applyReviewResults(null);
  memory.applyReviewResults([]);
  assert.equal(memory.getWeakPoints().length, 0);
});

test("applyReviewResults 无 topic 条目跳过", () => {
  memory.applyReviewResults([{ verdict: "错" }, { topic: "综合能力", verdict: "错" }]);
  assert.equal(memory.getWeakPoints().length, 0);
});

// ---------- 已掌握 ----------
test("addMastered 去重 + 上限30 + 清薄弱点", () => {
  memory.addWeakPoint("闭包", "x");
  memory.addMastered("闭包");
  memory.addMastered("闭包");
  assert.equal(memory.getMastered().length, 1);
  assert.equal(memory.getWeakPoints().length, 0, "掌握后清除薄弱点");
  for (let i = 0; i < 35; i++) memory.addMastered(`已掌握${i}`);
  assert.equal(memory.getMastered().length, 30);
});

// ---------- 学习进度 ----------
test("recordProgress 累积次数/状态", () => {
  memory.recordProgress("事件循环", "done");
  memory.recordProgress("事件循环", "reviewed");
  const p = memory.get().studyProgress["事件循环"];
  assert.equal(p.times, 2);
  assert.equal(p.done, true);
  assert.equal(p.reviewed, true);
});

// ---------- 画像摘要 ----------
test("getProfileSummary 组装画像", () => {
  memory.addInterests(["React"]);
  memory.addWeakPoint("事件循环", "x");
  const s = memory.getProfileSummary();
  assert.ok(s.includes("关注点：React"));
  assert.ok(s.includes("事件循环"));
  assert.ok(s.includes("目标：前端秋招"));
});

test("getProfileSummary 空状态仅剩目标", () => {
  // resetMemoryState 后 profile.target 默认"前端秋招"
  assert.equal(memory.getProfileSummary(), "目标：前端秋招");
});

// ---------- 面试会话 ----------
test("setInterview/getInterview/clearInterview 持久化(DB)", () => {
  assert.equal(memory.getInterview(), null);
  memory.setInterview({ position: "前端" });
  assert.equal(memory.getInterview().position, "前端");
  const row = db.prepare("SELECT value FROM settings WHERE key='interview'").get();
  assert.ok(row && JSON.parse(row.value).position === "前端", "DB 持久化");
  memory.clearInterview();
  assert.equal(memory.getInterview(), null);
});

test("saveInterviewHistory 持久化(DB) + 内存上限20", () => {
  for (let i = 0; i < 25; i++) {
    memory.saveInterviewHistory({ date: "2026-01-01", position: `岗${i}`, rounds: 1, avg: 60, dims: {}, report: "r" });
  }
  assert.equal(memory.getInterviewHistory().length, 20, "内存镜像保留最近 20 条");
  const n = db.prepare("SELECT COUNT(*) n FROM interview_history").get().n;
  assert.ok(n >= 20, "DB 全量保留");
});
