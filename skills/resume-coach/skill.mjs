// 简历优化技能：结构化输出亮点/风险/量化改进/面试预设问题（LLM 提炼，只读）
// 用户数据（简历）不是外部不可信内容，无需 untrusted 包裹；但输出要基于简历事实，不编造
import { llmChat, getReplyText, extractJson } from "../../lib/llm.mjs";

export const name = "resume-coach";
export const description = "简历优化建议（亮点/风险/量化改进/面试预设问题）";

export const tools = [
  {
    name: "review_resume",
    description:
      "分析简历并给出结构化优化建议：亮点（保留）、风险点（面试可能被拷打的）、可量化改进（把描述改成数字/结果导向）、面试官可能追问的问题。适合用户问'我的简历怎么样/怎么改'。",
    parameters: {
      type: "object",
      properties: {
        resume: { type: "string", description: "简历全文（粘贴文本，5000 字以内）" },
        target: { type: "string", description: "目标岗位方向（可选，如：前端校招 / AI Agent 前端）" },
      },
      required: ["resume"],
    },
    permission: "auto", // 只读分析
    async run({ resume, target }) {
      const text = String(resume || "").trim().slice(0, 5000);
      if (text.length < 50) return { ok: false, error: "简历内容太短，请粘贴完整简历文本" };
      const prompt = `你是资深前端面试官兼简历顾问。下面是候选人简历，请输出结构化优化建议。
目标岗位：${target || "前端开发（校招/实习）"}

要求：
1. highlights：3-5 个值得保留的亮点（真实依据简历）
2. risks：2-4 个面试可能被拷打/扣分的风险点（如：项目描述笼统、技术栈与目标岗位不匹配、无量化结果）
3. improvements：3-5 条**可执行**的修改建议（每条：原描述问题 → 怎么改 → 示例句式），强调量化（数字/指标/影响）
4. interviewQuestions：按简历内容预设 4-6 个面试官必问问题（项目深挖/技术追问）

只输出 JSON：{"highlights":[""],"risks":[""],"improvements":[{"issue":"","fix":"","example":""}],"interviewQuestions":[""]}`;

      try {
        const data = await llmChat(
          [{ role: "system", content: "你是资深前端面试官兼简历顾问，只输出合法 JSON，建议必须基于简历事实。" }, { role: "user", content: `${prompt}\n\n【简历】\n${text}` }],
          { maxTokens: 2000, temperature: 0.3, role: "resume-coach" }
        );
        const parsed = extractJson(getReplyText(data));
        if (!parsed || !Array.isArray(parsed.highlights)) return { ok: false, error: "简历分析失败（LLM 返回异常）" };
        return {
          ok: true,
          highlights: (parsed.highlights || []).slice(0, 5),
          risks: (parsed.risks || []).slice(0, 4),
          improvements: (parsed.improvements || []).slice(0, 5),
          interviewQuestions: (parsed.interviewQuestions || []).slice(0, 6),
          hint: "以上建议基于简历文本生成，改动前请自行核对事实",
        };
      } catch (e) {
        return { ok: false, error: `简历分析失败: ${String(e?.message || e).slice(0, 120)}` };
      }
    },
  },
];
