// MCP Server：把 Mashiro 的核心工具暴露成标准 Model Context Protocol
// 任何 MCP 客户端（Claude Code / Cursor / OpenCode）连上即可调用真白的能力
// 用法: node mcp-server.mjs  (stdio 传输，Claude Code 配置后自动连接)
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "./config.mjs";
import { getSettingsApiKey } from "./lib/llm.mjs";

// LLM 工具前置校验：无 key 时快速失败（修复：此前无 key 会走 llm 重试/failover 链，
// 干净环境（npm 安装后未配置）下卡 15s+ 才超时，体验为"工具挂了"而非"需要配置"）。
// 真实 key 链与 llm.mjs 一致：settings 表（共享桌宠数据目录时自动继承）> .env / 环境变量 / opencode
const NO_KEY_HINT = "⚠️ 未检测到 LLM API Key。请配置后重试：\n  Linux/macOS: export DEEPSEEK_API_KEY=sk-xxx\n  Windows: set DEEPSEEK_API_KEY=sk-xxx\n  （或让本包的数据目录指向你已有的 Mashiro 桌宠数据——设置中心配过的 key 会自动继承）";
function requireLlmKey() {
  let settingsKey = "";
  try { settingsKey = getSettingsApiKey() || ""; } catch { /* db 未就绪按无 key 处理 */ }
  return (settingsKey || config.apiKey) ? null : NO_KEY_HINT;
}

const server = new McpServer({
  name: "mashiro-desktop",
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
      const noKey = requireLlmKey();
      if (noKey) return { content: [{ type: "text", text: noKey }], isError: true };
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
      const noKey = requireLlmKey();
      if (noKey) return { content: [{ type: "text", text: noKey }], isError: true };
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

// ---------- 工具 5-8: 个人数据环境（简历/校招/日程/学习进度） ----------
// 数据源统一走 lib/context-providers.mjs（单数据源），桌宠内部 agent 与外部 agent 同通道
// 内联模式与既有工具一致（避免 helper 类型推断影响 server.tool overload 匹配）
server.tool(
  "get_personal_profile",
  "查看用户在个人主页上传的简历（教育背景/项目经历/技能栈/求职目标）",
  {},
  async () => {
    try {
      const { executeProviderTool } = await import("./lib/context-providers.mjs");
      const r = /** @type {any} */ (await executeProviderTool("get_personal_profile"));
      if (!r.ok) return { content: [{ type: "text", text: `⚠️ ${r.error || "读取失败"}` }], isError: true };
      if (r.empty) return { content: [{ type: "text", text: `${r.message || "暂无数据"}` }] };
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2).slice(0, 6000) }] };
    } catch (e) {
      console.error(`[mcp] get_personal_profile 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 读取简历失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

server.tool(
  "get_jobs_status",
  "查看校招推荐岗位/投递状态/收藏/公司统计",
  {},
  async () => {
    try {
      const { executeProviderTool } = await import("./lib/context-providers.mjs");
      const r = /** @type {any} */ (await executeProviderTool("get_jobs_status"));
      if (!r.ok) return { content: [{ type: "text", text: `⚠️ ${r.error || "读取失败"}` }], isError: true };
      if (r.empty) return { content: [{ type: "text", text: `${r.message || "暂无数据"}` }] };
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2).slice(0, 6000) }] };
    } catch (e) {
      console.error(`[mcp] get_jobs_status 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 读取校招数据失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

server.tool(
  "get_schedule_events",
  "查看面试/笔试日程安排（邮箱邀约识别）",
  {},
  async () => {
    try {
      const { executeProviderTool } = await import("./lib/context-providers.mjs");
      const r = /** @type {any} */ (await executeProviderTool("get_schedule_events"));
      if (!r.ok) return { content: [{ type: "text", text: `⚠️ ${r.error || "读取失败"}` }], isError: true };
      if (r.empty) return { content: [{ type: "text", text: `${r.message || "暂无数据"}` }] };
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2).slice(0, 6000) }] };
    } catch (e) {
      console.error(`[mcp] get_schedule_events 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 读取日程失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

server.tool(
  "get_study_progress",
  "查看学习进度总览（学习清单/复习卡/专项练习/真题/专注统计）",
  {},
  async () => {
    try {
      const { executeProviderTool } = await import("./lib/context-providers.mjs");
      const r = /** @type {any} */ (await executeProviderTool("get_study_progress"));
      if (!r.ok) return { content: [{ type: "text", text: `⚠️ ${r.error || "读取失败"}` }], isError: true };
      if (r.empty) return { content: [{ type: "text", text: `${r.message || "暂无数据"}` }] };
      return { content: [{ type: "text", text: JSON.stringify(r.data, null, 2).slice(0, 6000) }] };
    } catch (e) {
      console.error(`[mcp] get_study_progress 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 读取学习进度失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ---------- 工具 9: 本地项目源码档案（模拟面试/清单讲解/对话辅导共用素材） ----------
// 用户问「我的项目怎么介绍/怎么讲/哪里不足」时，agent 基于真实代码辅导表述（用户不会表述也没关系）
server.tool(
  "get_project_archives",
  "查看用户本地项目源码档案（技术栈/目录结构/核心实现/README——来自设置中心配置的项目名=目录）。用户询问自己项目的介绍/表述/面试准备时，必须先调用本工具基于真实代码辅导",
  {},
  async () => {
    try {
      const { getPersonalProjects, buildProjectArchive } = await import("./lib/personal-projects.mjs");
      const projects = getPersonalProjects();
      if (!projects.length) {
        return { content: [{ type: "text", text: "未配置个人项目源码。请在设置中心「🎯 简历项目源码」填 项目名=本地目录，配置后模拟面试/清单讲解/对话都能基于真实代码。" }] };
      }
      const text = projects
        .map((p) => {
          try {
            const a = buildProjectArchive(p);
            return `【${p.name}】\n${String(a.content || "").slice(0, 4000)}`;
          } catch { return `【${p.name}】\n（档案生成失败，目录可能已移动）`; }
        })
        .join("\n\n=====\n\n")
        .slice(0, 14000);
      return { content: [{ type: "text", text: text || "项目档案为空" }] };
    } catch (e) {
      console.error(`[mcp] get_project_archives 失败: ${e && e.message ? e.message : String(e)}`);
      return { content: [{ type: "text", text: `⚠️ 读取项目档案失败: ${e && e.message ? e.message : String(e)}` }], isError: true };
    }
  }
);

// ---------- 工具 10/11: project-guide（v2 追加：MCP 桥接——外部 agent 也能生成讲解指南） ----------
// 复用 skills/project-guide/skill.mjs 的实现（read_project_file 路径白名单 + generate map-reduce）
async function runProjectGuideTool(toolName, args) {
  try {
    const { tools } = await import("./skills/project-guide/skill.mjs");
    const tool = (Array.isArray(tools) ? tools : []).find((t) => t?.name === toolName);
    if (!tool) return { content: [/** @type {{ type: "text", text: string }} */({ type: "text", text: `⚠️ skill 工具 ${toolName} 未注册` })], isError: true };
    const r = await tool.run(args || {});
    return { content: [/** @type {{ type: "text", text: string }} */({ type: "text", text: JSON.stringify(r, null, 2).slice(0, 8000) })] };
  } catch (e) {
    console.error(`[mcp] ${toolName} 失败: ${e && e.message ? e.message : String(e)}`);
    return { content: [/** @type {{ type: "text", text: string }} */({ type: "text", text: `⚠️ ${toolName} 失败: ${e && e.message ? e.message : String(e)}` })], isError: true };
  }
}

server.tool(
  "generate_project_guide",
  "生成项目面试讲解指南（7 段：定位/选型/架构/亮点/问题清单/防御/简历 bullet）——基于真实源码（分层读取 + subagent 并行深读 + 覆盖范围透明），存档 output/project-guides/<项目名>.md。用户问'生成 XX 项目的面试讲解指南/我的项目怎么讲'时使用",
  { project: z.string().describe("项目名（personal_projects 配置中的 name）") },
  async ({ project }) => runProjectGuideTool("generate_project_guide", { project })
);

server.tool(
  "read_project_file",
  "读取已配置个人项目目录内的源码文件（路径白名单防穿越 + 50KB 上限；mode: head 前 200 行 / export 签名清单 / full 全文）。生成讲解指南时按需读关键文件、反馈修正时读对应源码",
  {
    project: z.string().describe("项目名（personal_projects 配置中的 name）"),
    file: z.string().describe("项目内相对路径，如 package.json / src/main.mjs"),
    mode: z.enum(["head", "export", "full"]).optional().describe("读取模式（默认 head）"),
  },
  async ({ project, file, mode }) => runProjectGuideTool("read_project_file", { project, file, mode })
);

// ---------- 启动（stdio 传输，供 MCP 客户端连接） ----------
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("✅ MCP server 已启动（Mashiro）");
