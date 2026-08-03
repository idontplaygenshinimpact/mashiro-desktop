// ai.mjs 单测：分类/挑帖/题目检测/讲解/压缩（mock LLM + 临时 DB）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("ai");
mockLLM(); // 拦截 ai.mjs 的动态 import("./llm.mjs")
const ai = await import("../lib/ai.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

// ---------- token 估算 ----------
test("estimateTokens 中文 1:1 / 英文 4:1", () => {
  assert.equal(ai.estimateTokens("中".repeat(100)), 100);
  assert.equal(ai.estimateTokens("a".repeat(400)), 100);
  assert.equal(ai.estimateTokens(""), 0);
  assert.equal(ai.estimateTokens(null), 0);
});
test("msgTokens/bodyTokens 计算消息体积", () => {
  assert.equal(ai.msgTokens({ role: "user", content: "中".repeat(100) }), 104); // 100 + 4 meta
  assert.equal(ai.bodyTokens([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), 8 + 2);
});

// ---------- classifyPage ----------
test("classifyPage 解析 LLM 返回", async () => {
  setLlmResponses('{"type":"mianshi","direction":"frontend","company":"字节","position":"前端","worth":8,"reason":"真实面经"}');
  const r = await ai.classifyPage({ title: "字节一面", text: "内容" });
  assert.equal(r.type, "mianshi");
  assert.equal(r.company, "字节");
});
test("classifyPage LLM 返回非法 → 兜底 other", async () => {
  setLlmResponses("乱码");
  const r = await ai.classifyPage({ title: "t", text: "x" });
  assert.equal(r.type, "other");
});

// ---------- pickPosts ----------
test("pickPosts 按 href 过滤 + 数量限制", async () => {
  setLlmResponses('{"picks":[{"text":"A","href":"u1","reason":"好"},{"text":"B","href":"","reason":"无链接"},{"text":"C","href":"u2","reason":"好"}]}');
  const r = await ai.pickPosts([{ text: "A", href: "u1" }, { text: "B", href: "" }, { text: "C", href: "u2" }], 5, []);
  assert.equal(r.length, 2);
  assert.equal(r[0].href, "u1");
});
test("pickPosts 解析失败 → fallback 全选", async () => {
  setLlmResponses("not json");
  const posts = [{ text: "A", href: "u1" }];
  const r = await ai.pickPosts(posts, 5, []);
  assert.equal(r.length, 1);
  assert.equal(r[0].reason, "fallback");
});

// ---------- detectQuestions ----------
test("detectQuestions 提取题目", async () => {
  setLlmResponses('{"hasQuestion":true,"questions":[{"question":"手写防抖节流"},{"question":"讲一下事件循环"}],"reason":"有具体题目"}');
  const r = await ai.detectQuestions({ title: "t", text: "x" });
  assert.equal(r.hasQuestion, true);
  assert.equal(r.questions.length, 2);
});
test("detectQuestions 无题目", async () => {
  setLlmResponses('{"hasQuestion":false,"questions":[],"reason":"攻略文"}');
  const r = await ai.detectQuestions({ title: "t", text: "x" });
  assert.equal(r.hasQuestion, false);
});

// ---------- solveQuestion ----------
test("solveQuestion 生成讲解", async () => {
  setLlmResponses("## 结论\n事件循环分宏微任务\n## 原理\n...\n## 实现JS\n```js\nconsole.log(1)\n```\n## 边界\n...");
  const md = await ai.solveQuestion({ title: "事件循环", text: "事件循环是什么", company: "字节", position: "前端", sourceUrl: "" });
  assert.ok(md.includes("## 结论"));
  assert.ok(md.includes("## 实现JS"));
});
test("solveQuestion 空响应不崩溃", async () => {
  setLlmResponses("");
  const md = await ai.solveQuestion({ title: "x", text: "y", company: "c", position: "前端", sourceUrl: "" });
  assert.equal(typeof md, "string");
});

// ---------- 流式讲解 ----------
test("solveQuestionStream 逐 chunk 回调", async () => {
  setLlmResponses("这是一段完整的讲解内容，会被切成小段回调。");
  let received = "";
  const full = await ai.solveQuestionStream({ title: "t", text: "x", company: "c", position: "前端", sourceUrl: "" }, (chunk) => { received += chunk; });
  assert.equal(received, "这是一段完整的讲解内容，会被切成小段回调。");
  assert.equal(full, received);
});

// ---------- compactMessages ----------
test("compactMessages 不超预算不压缩", async () => {
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
  const out = await ai.compactMessages(msgs);
  assert.equal(out.length, 3);
});

test("compactMessages 超预算 → 摘要注入 + 保留最近", async () => {
  setLlmResponses("这是压缩后的对话摘要，保留了知识点、用户目标和当前进度，长度必须超过二十个字符才算合格。");
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) {
    big.push({ role: "user", content: "前端面试高频考点详解内容".repeat(200) });
    big.push({ role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({ r: ["长结果".repeat(200)] }) });
  }
  const out = await ai.compactMessages(big);
  assert.ok(out.length < big.length, "消息数减少");
  assert.ok(out.some((m) => m.role === "system" && m.content.includes("此前对话摘要")), "摘要注入");
  assert.ok(out.some((m) => m.role === "tool"), "保留最近 tool 结果");
});

test("compactMessages 压缩失败 → 降级丢弃 tool 结果", async () => {
  setLlmResponses("", "", "", ""); // 3 次重试都空 → 降级
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 8; i++) {
    big.push({ role: "user", content: "内容".repeat(1000) }); // 每条 ≈2000 token，总超预算
    big.push({ role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({ r: ["x".repeat(1000)] }) });
  }
  const out = await ai.compactMessages(big);
  assert.ok(out.length < big.length, "降级也减少消息");
  assert.ok(!out.some((m) => m.content.includes("此前对话摘要")), "无摘要");
});
