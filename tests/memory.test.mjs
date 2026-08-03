// memory.mjs 单测：画像/关注点/薄弱点/已掌握/对话历史/复盘回流（临时 DB + 干净实例）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, freshMemory } from "./helpers.mjs";

const dbDir = setupTempDb("memory");
let memory;

beforeEach(async () => {
  await clearAllTables();
  memory = await freshMemory(); // 每次测试干净实例（共享 db 单例）
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 关注点 ----------
test("addInterests 去重 + trim + 持久化", async () => {
  memory.addInterests(["React", "字节", "React"]);
  memory.addInterests(["  Event Loop  "]);
  assert.deepEqual(memory.getInterests(), ["React", "字节", "Event Loop"]);
  const m2 = await freshMemory(); // 重启实例（重新 load 自 DB）
  assert.deepEqual(m2.getInterests(), ["React", "字节", "Event Loop"]);
});

test("addInterests 空值忽略/超长截断到 30 字符", () => {
  memory.addInterests(["", "   ", "x".repeat(50)]);
  assert.deepEqual(memory.getInterests(), ["x".repeat(30)]); // 截断后保留（设计行为）
});

// ---------- 已看帖子 ----------
test("markSeen/isSeen 持久化", async () => {
  assert.equal(memory.isSeen("http://a"), false);
  memory.markSeen("http://a");
  assert.equal(memory.isSeen("http://a"), true);
  const m2 = await freshMemory();
  assert.equal(m2.isSeen("http://a"), true);
});

// ---------- 对话历史 ----------
test("appendChat/getChatHistory 持久化", async () => {
  memory.appendChat("user", "你好");
  memory.appendChat("assistant", "你好呀");
  const hist = memory.getChatHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, "user");
  const m2 = await freshMemory();
  assert.equal(m2.getChatHistory().length, 2);
});

// ---------- 薄弱点 ----------
test("addWeakPoint 过滤伪知识点", () => {
  memory.addWeakPoint("综合能力", "复盘验证");
  memory.addWeakPoint("考察维度：深度", "复盘验证");
  memory.addWeakPoint("", "x");
  memory.addWeakPoint("事件循环", "复盘验证");
  const wps = memory.getWeakPoints();
  assert.equal(wps.length, 1);
  assert.equal(wps[0].topic, "事件循环");
});

test("addWeakPoint 同主题累加 failCount + 排序", () => {
  memory.addWeakPoint("A点", "s1");
  memory.addWeakPoint("A点", "s2");
  memory.addWeakPoint("B点", "s3");
  const wps = memory.getWeakPoints();
  assert.equal(wps.length, 2);
  assert.equal(wps[0].topic, "A点"); // failCount 高在前
  assert.equal(wps[0].failCount, 2);
});

test("addWeakPoint 持久化", async () => {
  memory.addWeakPoint("事件循环", "面试实录", "agent");
  const m2 = await freshMemory();
  const wp = m2.getWeakPoints()[0];
  assert.equal(wp.topic, "事件循环");
  assert.equal(wp.origin, "agent");
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
    { topic: "综合能力", verdict: "错" }, // 伪知识点跳过
    { topic: "原型链", verdict: "部分对" },
  ]);
  assert.deepEqual(memory.getMastered().map((m) => m.topic), ["闭包"]);
  const weak = memory.getWeakPoints().map((w) => w.topic).sort();
  assert.deepEqual(weak, ["事件循环", "原型链"]);
  assert.equal(memory.getWeakPoints().some((w) => w.topic === "闭包"), false, "掌握后清除薄弱点");
});

test("applyReviewResults 空结果不崩溃", () => {
  memory.applyReviewResults(null);
  memory.applyReviewResults([]);
  assert.equal(memory.getWeakPoints().length, 0);
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

// ---------- 面试会话 ----------
test("setInterview/getInterview/clearInterview 持久化", async () => {
  assert.equal(memory.getInterview(), null);
  memory.setInterview({ position: "前端" });
  assert.equal(memory.getInterview().position, "前端");
  const m2 = await freshMemory();
  assert.equal(m2.getInterview().position, "前端");
  memory.clearInterview();
  assert.equal(memory.getInterview(), null);
});

test("saveInterviewHistory 持久化", async () => {
  memory.saveInterviewHistory({ date: "2026-01-01", position: "前端", rounds: 3, avg: 80, dims: { tech: 80 }, report: "不错" });
  assert.equal(memory.getInterviewHistory().length, 1);
  const m2 = await freshMemory();
  assert.equal(m2.getInterviewHistory().length, 1);
});
