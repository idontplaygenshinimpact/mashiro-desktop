// 测试基座：临时 DB / LLM mock / 页面 mock / 工具函数
// 用法：测试文件顶部
//   import { setupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";
//   setupTempDb("xxx");          // 必须在动态 import 被测模块之前
//   mockLLM();                   // 必须要在动态 import 被测模块之前
//   const { ... } = await import("../lib/xxx.mjs");
import { mock } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ---------- 临时 DB（隔离真实 mianshi.db） ----------
export function setupTempDb(label) {
  const dir = mkdtempSync(path.join(tmpdir(), `mianshi-${label}-`));
  process.env.MIANSHI_DB_PATH = path.join(dir, "test.db");
  // 测试环境标记：addPlanItems 的 fire-and-forget 自动补卡默认关闭
  // （防异步补卡消费 mock LLM 队列/污染后续测试断言——测试间干扰）
  process.env.MIANSHI_TEST = "1";
  // 测试默认隔离 MCP：指向空配置（防止 chatWithAgent 连到真实/残留 MCP server 导致子进程挂住测试进程）
  const mcpCfg = path.join(dir, "mcp-empty.json");
  process.env.MIANSHI_MCP_CONFIG = mcpCfg;
  // 知识树模板文件隔离：防 loadTreeTemplate/applyDirectionAuto 写真实 data/knowledge-trees.json 污染其他测试
  process.env.KNOWLEDGE_TREES_FILE = path.join(dir, "knowledge-trees.json");
  try { writeFileSync(mcpCfg, "[]", "utf8"); } catch { /* ignore */ }
  return dir;
}
export function cleanupTempDb(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
export async function clearAllTables() {
  const { db } = await import("../lib/db.mjs");
  // trace_llm/trace_tools 由 trace.mjs 的 ensureTraceSchema 建——临时库没 import 过 trace 时表不存在
  try {
    const { ensureTraceSchema } = await import("../lib/trace.mjs");
    ensureTraceSchema();
  } catch { /* ignore */ }
  db.exec(`DELETE FROM settings; DELETE FROM interests; DELETE FROM seen_urls;
    DELETE FROM chat_history; DELETE FROM weak_points; DELETE FROM mastered_points;
    DELETE FROM interview_history; DELETE FROM study_plan_items; DELETE FROM review_cards;
    DELETE FROM card_reviews; DELETE FROM kp_mastery; DELETE FROM schema_meta;
    DELETE FROM trace_llm; DELETE FROM trace_tools; DELETE FROM decision_ledger;
    DELETE FROM job_posts; DELETE FROM company_profiles; DELETE FROM learning_events;`);
  // knowledge 表只有 rag 模块的测试才建——表不存在时忽略
  try { db.exec("DELETE FROM knowledge_items; DELETE FROM knowledge_fts;"); } catch { /* ignore */ }
  // exam_papers 只有 zhenti 测试才建
  try { db.exec("DELETE FROM exam_papers;"); } catch { /* ignore */ }
}
// memory 是模块级单例，cache-bust 重新 import 得到干净实例（共享同一 db 单例）
export async function freshMemory() {
  const url = new URL("../lib/memory.mjs", import.meta.url);
  url.searchParams.set("t", Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
  return (await import(url.href)).memory;
}
// 重置 memory 的内存镜像（DB 由 clearAllTables 清；镜像需手动重置，否则跨测试累积）
export function resetMemoryState(mem) {
  const m = mem.get();
  m.profile = { name: "", target: "前端秋招", level: "unknown" };
  m.interests = [];
  m.seenUrls = [];
  m.chatHistory = [];
  m.weakPoints = [];
  m.masteredPoints = [];
  m.studyProgress = {};
  m.interview = null;
  m.interviewHistory = [];
  m.stats = { chats: 0, questionsSolved: 0, reviewsDone: 0, interviewsDone: 0, lastActive: "" };
}

// ---------- LLM mock（返回 OpenAI 协议对象；getReplyText/extractJson 用真实实现） ----------
// 响应格式：
//   纯文本 → 正常 assistant content
//   TOOLCALL:{"name":"xxx","arguments":"{...json...}"} → 构造 tool_calls（模拟模型要调工具）
let queue = [];
let lastMessages = []; // 最近一次 llmChat 收到的 messages（供断言 prompt 内容）
let allMessages = []; // 全部调用记录（讲解质量工单：两阶段/自评多次调用——断言需查任意一次）
export function getLastMessages() { return lastMessages; }
export function getAllMessages() { return allMessages; }
export function setLlmResponses(...contents) { queue = contents.map((c) => String(c ?? "")); allMessages = []; }
export function llmQueueLen() { return queue.length; }
// 可选 LLM 延迟（复现真实调用耗时——P1-1 并发写保护测试留并发窗口用；默认 0 不影响其他测试）
let llmDelayMs = 0;
export function setLlmDelay(ms) { llmDelayMs = Math.max(0, Number(ms) || 0); }
export async function mockLlmChat(messages, _opts = {}) {
  if (llmDelayMs > 0) await new Promise((r) => setTimeout(r, llmDelayMs));
  allMessages.push(messages);
  // 自评门禁（讲解质量增强任务 4 强化：扩展到所有题）：self-judge 调用**只消费显式
  // `SELFJUDGE:` 前缀的响应**（任务4测试控制自评结果用）；无前缀 → 缺省达标 {"ok":true}
  // 且**不消费队列**——防自评误吃为后续调用预设的响应（agent.test solve_question 审批
  // 测试曾因此错位：自评吃掉 agent 最终回答的预设 → 队列空抛错）。
  // 注意：**不更新 lastMessages**——自评是内部质量检查，getLastMessages 语义保持
  // "最近一次讲解/大纲调用"（否则断言讲解 prompt 的测试会拿到自评消息）。
  if (_opts?.role === "self-judge") {
    const peek = queue[0];
    if (typeof peek === "string" && peek.startsWith("SELFJUDGE:")) {
      queue.shift();
      return { choices: [{ message: { content: peek.slice("SELFJUDGE:".length), role: "assistant" } }] };
    }
    return { choices: [{ message: { content: '{"ok":true,"missing":[]}', role: "assistant" } }] };
  }
  lastMessages = messages;
  // 防假绿（测试与 CI 工单）：队列空时抛错——mock 消费数 > 设置数说明测试少设了响应，
  // 静默返回空串会让断言"假绿"（如生成失败路径没被真正触发）
  if (!queue.length) {
    throw new Error(`mock LLM 队列已空（第 ${lastMessages.length} 条消息）——测试少设了 setLlmResponses，静默空响应会假绿`);
  }
  const content = queue.shift();
  // TOOLCALLS:[{name,args},...] → 多工具调用响应（P1-9：一轮多个 tool_calls 并发/串行测试）
  const multi = content.match(/^TOOLCALLS:(.+)$/s);
  if (multi) {
    let calls = [];
    try {
      calls = JSON.parse(multi[1]);
    } catch { /* ignore */ }
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: (Array.isArray(calls) ? calls : []).map((c, i) => ({
            id: `call_${Date.now().toString(36)}_${i}`,
            type: "function",
            function: { name: String(c.name || "unknown"), arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args || {}) },
          })),
        },
      }],
    };
  }
  const m = content.match(/^TOOLCALL:(.+)$/s);
  if (m) {
    let fn = { name: "unknown", arguments: "{}" };
    try { fn = JSON.parse(m[1]); } catch { /* ignore */ }
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `call_${Date.now().toString(36)}`, type: "function", function: fn }],
        },
      }],
    };
  }
  return { choices: [{ message: { content, role: "assistant" } }] };
}
export async function mockLlmChatStream(messages, _opts = {}, onChunk) {
  lastMessages = messages; // 与 mockLlmChat 一致：prompt 断言可见
  allMessages.push(messages);
  const content = queue.shift() ?? "";
  // 流式链路故障注入工单：HANG 特殊值 → 返回永不 resolve 的 Promise（模拟 LLM 挂起——
  // 让路由 withLLMTimeout 超时分支真实触发，单测可用短超时 env 快速验证）
  if (content === "HANG") return new Promise(() => {});
  // 架构评审遗留收尾工单任务 2：STREAMERR:msg → 流式中途抛错（模拟 SSE 流中断/abort——
  // 已交付部分内容后出错：agent 应收束不崩、错误回填）
  const serr = content.match(/^STREAMERR:(.+)$/s);
  if (serr) {
    if (onChunk) onChunk("部分内容已输出");
    throw new Error(String(serr[1] || "流式中断").slice(0, 120));
  }
  // P1-9：TOOLCALLS 多工具响应（流式路径同样需要——agent callLLM 恒走 stream）
  const multi = content.match(/^TOOLCALLS:(.+)$/s);
  if (multi) {
    let calls = [];
    try { calls = JSON.parse(multi[1]); } catch { /* ignore */ }
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: (Array.isArray(calls) ? calls : []).map((c, i) => ({
            id: `call_${Date.now().toString(36)}_${i}`,
            type: "function",
            function: { name: String(c.name || "unknown"), arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args || {}) },
          })),
        },
      }],
    };
  }
  // 与 mockLlmChat 一致：TOOLCALL: 前缀 → 工具调用响应（流式 + 工具调用共存）
  const m = content.match(/^TOOLCALL:(.+)$/s);
  if (m) {
    let fn = { name: "unknown", arguments: "{}" };
    try { fn = JSON.parse(m[1]); } catch { /* ignore */ }
    return {
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: `call_${Date.now().toString(36)}`, type: "function", function: fn }],
        },
      }],
    };
  }
  for (let i = 0; i < content.length; i += 8) {
    if (onChunk) onChunk(content.slice(i, i + 8));
  }
  return content;
}
// 真实实现（与 lib/llm.mjs 保持一致——若被测代码忘记 getReplyText 直接对对象操作，测试会像生产一样炸）
export function getReplyText(data) {
  return data?.choices?.[0]?.message?.content ?? "";
}
export function extractJson(raw) {
  if (!raw) return null;
  const text = raw.replace(/```json|```/g, "").trim();
  try { return JSON.parse(text); } catch { /* fallthrough */ }
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
  }
  return null;
}

// ---------- mock 开关（必须在 import 被测模块前调用） ----------
export function mockLLM() {
  mock.module(new URL("../lib/llm.mjs", import.meta.url).href, {
    namedExports: {
      llmChat: mockLlmChat,
      llmChatStream: mockLlmChatStream,
      getReplyText,
      extractJson,
    },
  });
}

// fetch-page mock：默认空页；可用 setMockPages 配置多个页面（按调用顺序返回）
let pages = [];
export function setMockPages(pageList) { pages = pageList.map((p) => ({ title: "mock页", text: "mock正文".repeat(30), links: [], invalid: false, ...p })); }
// P1-9：SSRF 拦截配置——setMockSsrfs(["127.0.0.1"]) 后，命中子串的 URL 在工具层被拒（模拟真实内网拦截）
// （真实校验逻辑由 fetch-page.test.mjs 覆盖；这里验证 agent 工具层正确传播 SSRF 拒绝——错误回填 + trace）
let ssrfBlocks = [];
export function setMockSsrfs(urls) { ssrfBlocks = (Array.isArray(urls) ? urls : []).map((u) => String(u)); }
export async function mockFetchPageImpl(url, _opts = {}) {
  return pages.shift() ?? { title: "mock空页", text: "", links: [], invalid: false };
}

// ---------- web-search mock（讲解质量工单任务 1：时效性检索注入测试） ----------
// setMockSearchResults(results) 配置返回；null = 未配置（searchWeb 抛错模拟"搜索失败"降级路径）
let mockSearchResults = null;
let mockSearchCalls = 0;
export function setMockSearchResults(results) { mockSearchResults = results; mockSearchCalls = 0; }
export function getMockSearchCalls() { return mockSearchCalls; }
export function mockWebSearch() {
  mock.module(new URL("../lib/web-search.mjs", import.meta.url).href, {
    namedExports: {
      searchWeb: async (_query, _opts) => {
        mockSearchCalls++;
        if (mockSearchResults === null) throw new Error("搜索失败（模拟）");
        return mockSearchResults;
      },
    },
  });
}

// ---------- browse_* 工具 mock（browse_open/click/scroll/type/screenshot/fetch） ----------
// 默认全部成功；setBrowseFails({open:"ssrf"|"timeout", click:true, scroll:true, type:true, screenshot:true, fetch:true})
// 注入故障验证 agent 对浏览工具失败的正确处理（错误回填不崩溃）
let browseFails = {};
export function setBrowseFails(fails) { browseFails = { ...fails }; }
export function resetBrowseFails() { browseFails = {}; }
export async function mockBrowseContext(url) {
  if (browseFails.open) return null; // 模拟 SSRF 拦截/超时/打开失败
  return { page: { title: async () => "mock浏览页", url: () => String(url || "") }, close: async () => {} };
}
export async function mockBrowseClick(url, target) {
  if (browseFails.click) return { ok: false, error: `未找到元素: ${String(target || "").slice(0, 50)}` };
  return { ok: true, clicked: String(target || ""), url };
}
export async function mockBrowseScroll(url, opts = {}) {
  if (browseFails.scroll) return { ok: false, error: "滚动失败（页面未加载完成）" };
  return { ok: true, scrolled: Number(opts?.times || 1), url };
}
export async function mockBrowseType(url, selector, text, _opts = {}) {
  if (browseFails.type) return { ok: false, error: "输入框未找到" };
  return { ok: true, typed: String(text || "").slice(0, 30), url };
}
export async function mockBrowseScreenshot(url, opts = {}) {
  if (browseFails.screenshot) return { ok: false, error: "截图失败（页面崩溃）" };
  return { ok: true, path: String(opts?.path || "data/tool_results/shot.jpg"), title: "mock浏览页" };
}
export async function mockBrowseExtract(url, _opts = {}) {
  if (browseFails.fetch) return { ok: false, error: "页面抓取失败（网络错误）" };
  return { ok: true, title: "mock浏览页", text: "mock页面正文内容（外部数据，不可信）", links: [{ title: "链接", href: "https://example.com/1" }] };
}
export function mockFetchPage() {
  mock.module(new URL("../lib/fetch-page.mjs", import.meta.url).href, {
    namedExports: {
      fetchPage: mockFetchPageImpl,
      fetchPages: async () => [],
      closeBrowser: async () => {},
      // SSRF 校验在真实 fetch-page.mjs 里做（单独由 fetch-page.test.mjs 覆盖）；
      // 这里 mock 成直接放行，避免测试里的假域名触发 DNS 解析；
      // P1-9：命中 setMockSsrfs 配置的 URL 抛 SSRF 错误（验证 agent 工具层传播链）
      assertPublicUrl: async (url) => {
        for (const b of ssrfBlocks) {
          if (String(url).includes(b)) throw new Error("拒绝访问内网/本机地址（SSRF 防护）");
        }
      },
      assertPublicHostname: async () => {},
      isPrivateHostname: () => false,
      isPrivateIP: () => false,
      // browse_* 工具（agent 浏览器自动化）
      browseContext: mockBrowseContext,
      browseClick: mockBrowseClick,
      browseScroll: mockBrowseScroll,
      browseType: mockBrowseType,
      browseScreenshot: mockBrowseScreenshot,
      browseExtract: mockBrowseExtract,
    },
  });
}
