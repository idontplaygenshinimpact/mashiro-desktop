// 模拟面试：面试官 LLM 决策（工具轮 + 统一 chat 客户端）
// 纵向拆分第 5 刀：interview-agent 域
// 两段式出题：决策轮（INTERVIEWER_TOOLS 检索项目资源）→ 出题轮；LLM 不调工具时退化为单次
import { llmChat, getReplyText } from "./llm.mjs";

// ---------- 面试官工具（agent 化：出题前可检索项目资源，全部只读、无副作用） ----------
// 让面试官消费已有的内容资产：448 道题库 / 候选人项目源码档案 / 知识库 / 薄弱点——
// 而不是只靠 LLM 记忆凭空出题（深挖"没货"是固定轮次死板的深层原因之一）
export const INTERVIEWER_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_challenge",
      description: "从本地题库（448 道手写/算法题，含题干、难度、频率）按知识点/关键词检索题目。需要出代码题/手写题/算法题（handwrite/coding 类轮次）时**必须**调用，从题库选真实题目，不要凭空编题。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "知识点或关键词，如'链表反转'、'Promise'、'二分查找'" },
          difficulty: { type: "integer", description: "1=简单 2=中等 3=困难（可选，不填返回全部难度）" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_project_archive",
      description: "检索候选人本地项目源码档案（真实代码：技术栈/目录结构/核心实现）。项目拷打轮深挖时调用，基于真实代码追问（如具体某个模块怎么实现、潜在 bug、可优化点），不要泛泛而谈。",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string", description: "关键词，如'状态机'、'SSE'、'缓存'、'数据库'（可选，空则看项目概览）" } },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description: "检索本地知识库（历史面经讲解、学习清单、复习卡、官方文档）。想考'候选人学过没学好'的知识点，或需要依据候选人自己的学习材料出题时调用。",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "检索词，如'事件循环'、'虚拟DOM'、'HTTP缓存'" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weak_points",
      description: "查看候选人全部薄弱点（复盘/面试答错的知识点及失败次数）。八股/手写/场景轮出题时优先从薄弱点中选题。",
      parameters: { type: "object", properties: {} },
    },
  },
];

/** 执行面试官工具（只读）；失败返回 {error} 不抛出（不影响出题流程） */
export async function runInterviewerTool(name, args = {}) {
  try {
    if (name === "search_challenge") {
      const { getChallenges } = await import("./ai-career.mjs");
      const q = String(args.query || "").toLowerCase();
      const diff = Number(args.difficulty) || 0;
      const list = getChallenges({}).filter((c) =>
        (!diff || c.difficulty === diff) &&
        (!q || c.title.toLowerCase().includes(q) || String(c.description || "").toLowerCase().includes(q))
      ).slice(0, 5);
      if (!list.length) return { error: `题库无匹配「${args.query}」的题目，换个关键词或难度` };
      return { items: list.map((c) => ({ title: c.title, difficulty: c.difficulty, category: c.category, description: String(c.description || "").slice(0, 150) })) };
    }
    if (name === "search_project_archive") {
      const { getPersonalProjects, buildProjectArchive } = await import("./personal-projects.mjs");
      const kw = String(args.keyword || "").toLowerCase();
      const out = [];
      for (const p of getPersonalProjects() || []) {
        try {
          const arch = buildProjectArchive(p);
          const text = JSON.stringify(arch || {}).toLowerCase();
          if (kw && !text.includes(kw)) continue;
          out.push({ project: p.name, archive: JSON.stringify(arch).slice(0, 1500) });
        } catch { /* ignore */ }
      }
      return out.length ? { items: out.slice(0, 3) } : { error: `项目档案无匹配「${args.keyword}」，可换关键词或提醒候选人配置源码` };
    }
    if (name === "search_knowledge") {
      const { searchKnowledge } = await import("./rag.mjs");
      const hits = await searchKnowledge(String(args.query || ""), 3);
      if (!hits?.length) return { error: `知识库无匹配「${args.query}」（可能未启用或未构建）` };
      return { items: hits.map((h) => ({ title: h.title || h.kind, snippet: String(h.content || "").slice(0, 250) })) };
    }
    if (name === "get_weak_points") {
      const { memory } = await import("./memory.mjs");
      const w = memory.getWeakPoints() || [];
      return { items: w.slice(0, 12).map((x) => ({ topic: x.topic, failCount: x.failCount })) };
    }
    return { error: `未知工具: ${name}` };
  } catch (e) {
    return { error: `工具调用失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 面试官决策轮安全解析（工具参数/JSON 提取） */
export function ivSafeParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

// ---------- LLM 调用（统一客户端，带重试+超时） ----------
/**
 * @param {Array<{role: string, content?: string, tool_calls?: Array<object>, tool_call_id?: string}>} messages
 * @param {{maxTokens?: number, temperature?: number, timeout?: number, tools?: Array<object>, toolChoice?: string}} [opts]
 */
export async function chat(messages, { maxTokens = 4000, temperature = 0.4, timeout = undefined, tools = undefined, toolChoice = undefined } = {}) {
  const data = await llmChat(messages, {
    maxTokens, temperature,
    ...(timeout ? { timeout } : {}),
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { toolChoice } : {}),
  });
  return getReplyText(data);
}
