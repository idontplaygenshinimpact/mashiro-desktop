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
    DELETE FROM job_posts; DELETE FROM company_profiles;`);
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
export function getLastMessages() { return lastMessages; }
export function setLlmResponses(...contents) { queue = contents.map((c) => String(c ?? "")); }
export function llmQueueLen() { return queue.length; }
export async function mockLlmChat(messages, _opts = {}) {
  lastMessages = messages;
  const content = queue.shift() ?? "";
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
  const content = queue.shift() ?? "";
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
export async function mockFetchPageImpl(url, _opts = {}) {
  return pages.shift() ?? { title: "mock空页", text: "", links: [], invalid: false };
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
      // 这里 mock 成直接放行，避免测试里的假域名触发 DNS 解析
      assertPublicUrl: async () => {},
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
