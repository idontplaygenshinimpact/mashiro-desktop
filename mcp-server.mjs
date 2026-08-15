// MCP Server：把 mianshi-agent 的核心工具暴露成标准 Model Context Protocol
// 任何 MCP 客户端（Claude Code / Cursor / OpenCode）连上即可调用真白的能力
// 用法: node mcp-server.mjs  (stdio 传输，Claude Code 配置后自动连接)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "mianshi-agent",
  version: "0.1.0",
});

// ---------- 工具 1: 搜索面经 ----------
server.tool(
  "search_posts",
  "搜索前端/AI Agent 面经、笔试真题（牛客/掘金/CSDN），返回帖子标题+链接",
  { query: z.string().describe("搜索关键词，如 React面经 / 拼多多笔试 / Agent面试"),
    site: z.enum(["auto", "nowcoder", "juejin", "csdn"]).optional().describe("站点，默认 auto（牛客+掘金）") },
  async ({ query, site }) => {
    try {
      const { toolSearchPosts } = await import("./lib/agent.mjs");
      // 复用 agent 的搜索工具（含标题过滤/去重/AI挑帖）
      const r = await toolSearchPosts(query, site || "auto");
      const text = (r.results || []).slice(0, 6)
        .map((p) => `- ${p.title}\n  ${p.url}${p.site ? ` (${p.site})` : ""}`)
        .join("\n") || "没有找到结果";
      return { content: [{ type: "text", text }] };
    } catch (e) {
      console.error(`[mcp] search_posts 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 搜索失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ---------- 工具 2: 讲解题目 ----------
server.tool(
  "solve_question",
  "完整讲解一道前端/AI Agent 面试题（结论/原理/JS实现/边界），代码用 JS/TS",
  { question: z.string().describe("要讲解的问题或知识点，如：事件循环 / React Hooks 原理 / 防抖节流"),
    verify_question: z.string().optional().describe("附加的验证题（可选）") },
  async ({ question }) => {
    try {
      const { solveQuestion } = await import("./lib/ai.mjs");
      const md = await solveQuestion({
        title: question,
        text: `这是一道前端面试题，请完整讲解：${question}\n（若题干信息不足，围绕知识点本身展开：核心概念、原理、代码示例、边界情况）`,
        company: "MCP",
        position: "前端",
        sourceUrl: "mcp://solve_question",
      });
      return { content: [{ type: "text", text: String(md).slice(0, 8000) }] };
    } catch (e) {
      console.error(`[mcp] solve_question 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 讲解失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ---------- 工具 3: 查看学习清单 ----------
server.tool(
  "get_study_plan",
  "查看当前学习清单（必会/进阶/拓展分层），了解待学知识点",
  {},
  async () => {
    try {
      const { getPlan } = await import("./lib/study.mjs");
      const plan = getPlan();
      const items = (plan.items || []).filter((i) => !i.done);
      const text = items.length
        ? items.map((i) => `- [${i.level || "必会"}] ${i.topic}${i.source ? `（来源：${i.source}）` : ""}`).slice(0, 15).join("\n")
        : "学习清单已全部完成 🎉";
      return { content: [{ type: "text", text: `今日待学 ${items.length} 项：\n${text}` }] };
    } catch (e) {
      console.error(`[mcp] get_study_plan 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 读取学习清单失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ---------- 工具 4: 开始模拟面试 ----------
server.tool(
  "start_interview",
  "开始一场模拟面试（技术深挖型/温和引导型/压力追问型），返回第一问+考察维度+合格标准",
  { position: z.string().describe("目标岗位，如：前端实习生 / AI Agent 应用开发"),
    role: z.enum(["技术深挖型", "温和引导型", "压力追问型"]).optional().describe("面试官风格"),
    focus: z.string().optional().describe("重点方向，如 React / 事件循环") },
  async ({ position, role, focus }) => {
    try {
      const { startInterview } = await import("./lib/interview.mjs");
      const r = await startInterview({ position, role: role || "技术深挖型", focus });
      if (r.error) return { content: [{ type: "text", text: `⚠️ ${r.error}` }] };
      return { content: [{ type: "text", text: `第 ${r.round} 轮\n🎯 维度：${r.dimension}\n📌 依据：${r.basis}\n✅ 合格标准：${r.criteria}\n\n问题：${r.question}` }] };
    } catch (e) {
      console.error(`[mcp] start_interview 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 开始面试失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ---------- 启动（stdio 传输，供 MCP 客户端连接） ----------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP server 已启动（mianshi-agent）");
