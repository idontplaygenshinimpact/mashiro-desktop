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

test("solveAppendStream 追问补充流式", async () => {
  setLlmResponses("补充内容：Hooks 闭包陷阱的具体例子。");
  let received = "";
  const full = await ai.solveAppendStream(
    { question: "Hooks 原理", existing: "已有讲解", ask: "再讲讲闭包陷阱" },
    (chunk) => { received += chunk; }
  );
  assert.ok(received.length > 0);
  assert.equal(full, received);
});

test("consolidateStudyStream 多轮问答整理成完整讲解", async () => {
  setLlmResponses("## 完整讲解\n这是整理后的内容，覆盖所有轮次。");
  let received = "";
  const full = await ai.consolidateStudyStream(
    { topic: "事件循环", content: "第一轮讲解…\n追问补充…" },
    (chunk) => { received += chunk; }
  );
  assert.ok(full.includes("完整讲解"));
  assert.equal(full, received);
});

test("clusterStudyStream 多条目归并主题簇", async () => {
  setLlmResponses("## 主题簇综合讲解\nMySQL 索引与 B+ 树相关知识。");
  let received = "";
  const full = await ai.clusterStudyStream({
    topics: [{ topic: "B树", content: "B+树原理" }, { topic: "回表", content: "回表查询" }],
    onChunk: (chunk) => { received += chunk; },
  });
  assert.ok(full.includes("主题簇"));
  assert.equal(full, received);
});

test("summarizeQiuzhao 招聘信息摘要", async () => {
  setLlmResponses("字节2026秋招启动，前端岗8月1日开投。");
  const r = await ai.summarizeQiuzhao({ title: "字节招聘", text: "字节跳动2026届秋招正式启动……", company: "字节", sourceUrl: "u" });
  assert.ok(r.length > 0);
  assert.ok(r.includes("字节"));
});

test("chat 简单 LLM 调用返回文本", async () => {
  setLlmResponses("简单回答。");
  const r = await ai.chat([{ role: "user", content: "hi" }], { maxTokens: 100 });
  assert.equal(r, "简单回答。");
});

// ---------- 简历项目提取 ----------
test("extractResumeProjects 提取项目列表", async () => {
  setLlmResponses('{"projects":[{"name":"低代码平台","tech_stack":"React,TypeScript","description":"负责渲染引擎"},{"name":"AI面试助手","tech_stack":"Node.js,LLM","description":"负责对话链路"}]}');
  const projects = await ai.extractResumeProjects("我的简历：做过低代码平台和AI面试助手……");
  assert.equal(projects.length, 2);
  assert.equal(projects[0].name, "低代码平台");
  assert.ok(projects[0].techStack.includes("React"));
});

test("extractResumeProjects 空/非法返回空数组", async () => {
  setLlmResponses("不是 JSON");
  const projects = await ai.extractResumeProjects("简历内容");
  assert.deepEqual(projects, []);
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

// ---------- 压缩量化验证 ----------
test("压缩量化：token 显著减少 + 保留最近上下文", async () => {
  setLlmResponses("这是压缩后的对话摘要，保留了知识点用户目标和当前进度，长度足够超过审计阈值。");
  const big = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 10; i++) {
    big.push({ role: "user", content: "前端面试高频考点".repeat(300) }); // ≈3000 token/条
    big.push({ role: "tool", tool_call_id: `t${i}`, content: JSON.stringify({ r: ["长结果".repeat(300)] }) });
  }
  const before = ai.bodyTokens(big.filter((m) => m.role !== "system"));
  assert.ok(before > ai.COMPACT_CONFIG.budget, "构造数据超过预算");

  const out = await ai.compactMessages(big);
  const after = ai.bodyTokens(out.filter((m) => m.role !== "system"));
  const summaryMsg = out.find((m) => m.role === "system" && m.content.includes("此前对话摘要"));
  assert.ok(summaryMsg, "摘要注入");
  assert.ok(after < before * 0.3, `压缩后 token 减少 70%+（前 ${before} → 后 ${after}）`);
  // 保留最近：out 尾部是原始最近消息（非摘要）
  const tail = out[out.length - 1];
  assert.ok(tail.content.includes("长结果"), "保留最近工具结果");
});

test("压缩参数可配置：COMPACT_BUDGET 环境变量生效", async () => {
  const prev = process.env.COMPACT_BUDGET;
  process.env.COMPACT_BUDGET = "5000";
  try {
    // config.mjs 模块级缓存——用查询参数强制重新加载验证 env 读取
    const cfg2 = await import(`../config.mjs?t=${Date.now()}`);
    assert.equal(cfg2.config.compactBudget, 5000, "config 从 env 读取");
  } finally {
    if (prev === undefined) delete process.env.COMPACT_BUDGET; else process.env.COMPACT_BUDGET = prev;
  }
});
