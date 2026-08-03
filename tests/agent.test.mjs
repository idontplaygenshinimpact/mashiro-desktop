// agent.mjs 单测：工具循环 / 参数校验 / 压缩 / 记忆（mock LLM + mock fetch-page + 临时 DB）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, mockFetchPage, setLlmResponses, setMockPages, resetMemoryState } from "./helpers.mjs";

const dbDir = setupTempDb("agent");
mockLLM();
mockFetchPage();
const { chatWithAgent, toolSearchPosts } = await import("../lib/agent.mjs");
const { memory } = await import("../lib/memory.mjs");

beforeEach(async () => {
  await clearAllTables();
  resetMemoryState(memory); // 清内存镜像（DB 清了但模块级镜像累积）
  setMockPages([]);
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 简单对话 ----------
test("chatWithAgent 简单对话：回复 + 语音解析", async () => {
  setLlmResponses("事件循环要先分清宏任务和微任务哦【语音】这个知识点其实很简单的呢~");
  const r = await chatWithAgent("讲讲事件循环");
  assert.ok(r.reply.includes("宏任务"), "回复内容");
  assert.equal(r.voice, "这个知识点其实很简单的呢~", "语音稿提取");
  assert.ok(!r.reply.includes("【语音】"), "语音稿从回复中移除");
  assert.ok(Array.isArray(r.history) && r.history.length >= 2);
});

test("chatWithAgent 语音为无 → voice 空", async () => {
  setLlmResponses("好的。【语音】无");
  const r = await chatWithAgent("hi");
  assert.equal(r.voice, "");
  assert.equal(r.reply, "好的。");
});

test("chatWithAgent 对话记忆追加", async () => {
  setLlmResponses("收到");
  await chatWithAgent("你好");
  const hist = memory.getChatHistory();
  assert.equal(hist.length, 2);
  assert.equal(hist[0].role, "user");
  assert.equal(hist[0].content, "你好");
});

// ---------- 工具循环 ----------
test("chatWithAgent 工具循环：先调工具再回答", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"plan_task","arguments":"{\\"goal\\":\\"测试\\",\\"steps\\":[\\"第一步\\"]}"}',
    "计划已确认，正在执行。"
  );
  const r = await chatWithAgent("帮我规划任务");
  assert.ok(r.reply.includes("计划已确认"));
  // 工具执行成功且 trace 已记录
  const { getRecentTools } = await import("../lib/trace.mjs");
  const tools = getRecentTools(5);
  assert.ok(tools.some((t) => t.tool_name === "plan_task" && t.ok), "plan_task 工具执行记录");
});

test("chatWithAgent 参数缺失 → 工具报错回填 → LLM 修正后回答", async () => {
  setLlmResponses(
    // 缺 question（solve_question 必填）→ validateArgs 报错
    'TOOLCALL:{"name":"solve_question","arguments":"{}"}',
    "抱歉参数不全，我重新整理后回答：事件循环原理。"
  );
  const r = await chatWithAgent("讲讲事件循环");
  assert.ok(r.reply.includes("事件循环"), "LLM 修正后给出回答");
  const { getRecentTools } = await import("../lib/trace.mjs");
  const tools = getRecentTools(5);
  const bad = tools.find((t) => t.tool_name === "solve_question");
  assert.ok(bad && !bad.ok, "参数错误记录为失败调用");
});

test("chatWithAgent 记忆类工具：remember 写入关注点", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"remember","arguments":"{\\"topics\\":[\\"React\\",\\"字节\\"]}"}',
    "记住啦，会帮你盯着 React 和字节的面经。"
  );
  const r = await chatWithAgent("关注 React 和字节");
  assert.ok(r.reply.includes("记住"));
  assert.deepEqual(memory.getInterests(), ["React", "字节"]);
});

test("chatWithAgent 未知工具名 → 报错不崩溃", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"不存在的工具","arguments":"{}"}',
    "好的，我换个方式回答。"
  );
  const r = await chatWithAgent("x");
  assert.ok(r.reply.length > 0);
});

// ---------- 上下文压缩触发 ----------
test("chatWithAgent 长历史触发压缩后仍正常回答", async () => {
  // 触发条件是 token 预算（18000）不是条数：每条消息要足够长（≈400 token）
  setLlmResponses("这是一段足够长的对话摘要内容，超过二十个字符的审计阈值，用于测试压缩流程。", "压缩后正常回答。");
  const longHistory = [];
  for (let i = 0; i < 32; i++) {
    longHistory.push({ role: "user", content: `历史问题${i}：`.padEnd(0) + "事件循环原理详细内容".repeat(60) });
    longHistory.push({ role: "assistant", content: `历史回答${i}：` + "宏任务微任务执行顺序详解".repeat(60) });
  }
  const r = await chatWithAgent("新问题", longHistory);
  assert.equal(r.reply, "压缩后正常回答。", "压缩摘要后正常回答");
});

// ---------- 搜索工具（mock 页面） ----------
test("toolSearchPosts 空页面返回空结果", async () => {
  setMockPages([{ links: [] }, { links: [] }]); // nowcoder + juejin 两个站
  const r = await toolSearchPosts("React 面经");
  assert.ok(Array.isArray(r.results));
});

test("toolSearchPosts 标题过滤（嵌入式方向排除）+ 去重", async () => {
  setMockPages([
    {
      links: [
        { href: "https://www.nowcoder.com/discuss/111", text: "字节前端一面面经" },
        { href: "https://www.nowcoder.com/discuss/222", text: "嵌入式开发求职记录" },
        { href: "https://www.nowcoder.com/discuss/333", text: "拼多多笔试真题回忆" },
      ],
    },
    {
      links: [
        { href: "https://juejin.cn/post/444", text: "字节前端一面面经（转载）" }, // 与第一条同题不同源
        { href: "https://juejin.cn/post/555", text: "React Hooks 面试题整理" },
      ],
    },
  ]);
  const r = await toolSearchPosts("前端面经");
  const titles = r.results.map((p) => p.title);
  assert.ok(!titles.some((t) => t.includes("嵌入式")), "非前端方向被过滤");
  const dupe = titles.filter((t) => t.startsWith("字节前端一面面经"));
  assert.ok(dupe.length <= 1, "跨源同帖去重");
  assert.ok(titles.some((t) => t.includes("React Hooks")), "有效帖保留");
});
