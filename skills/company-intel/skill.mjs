// 公司面经情报技能：搜目标公司面经 → 抓 2 篇 → LLM 汇总高频考点与真题线索
// 只读；复用 agent 的搜索工具与抓页能力（动态 import，无循环依赖）
import { llmChat, getReplyText, extractJson } from "../../lib/llm.mjs";
import { sanitizeExternal } from "../../lib/prompt-guard.mjs";

export const name = "company-intel";
export const description = "目标公司面经情报（高频考点+真题线索）";

export const tools = [
  {
    name: "collect_company_intel",
    description:
      "搜集目标公司的面经并汇总高频考点：搜索该公司面经帖子 → 抓取正文 → 提炼 TOP 考点 + 真题线索链接 + 准备建议。适合用户问'XX 公司面试考什么/帮我查 XX 面经'。",
    parameters: {
      type: "object",
      properties: {
        company: { type: "string", description: "公司名，如：字节跳动 / 拼多多 / 美团" },
        position: { type: "string", description: "岗位方向（可选，如：前端）" },
      },
      required: ["company"],
    },
    permission: "auto", // 只读搜集
    async run({ company, position }) {
      const comp = String(company || "").trim().slice(0, 30);
      if (!comp) return { ok: false, error: "公司名不能为空" };
      const query = `${comp} ${position || "前端"} 面经`;
      // 1) 搜索面经帖子（复用 agent 的 toolSearchPosts：过滤/去重/AI 挑帖）
      let posts = [];
      try {
        const { toolSearchPosts } = await import("../../lib/agent.mjs");
        const r = await toolSearchPosts(query, "auto");
        posts = (r.results || []).slice(0, 5);
      } catch { /* 搜索失败走空列表 */ }
      if (!posts.length) {
        return { ok: false, error: `没找到「${comp}」相关面经帖子，试试换关键词或稍后再查（牛客部分帖子需登录）` };
      }
      // 2) 抓前 2 篇正文（串行 + 失败跳过）
      const pages = [];
      try {
        const { fetchPage } = await import("../../lib/fetch-page.mjs");
        for (const p of posts.slice(0, 2)) {
          try {
            const page = await fetchPage(p.url, { maxTextChars: 6000, waitUntil: "domcontentloaded" });
            if (page && !page.invalid && page.text) pages.push({ title: p.title, url: p.url, text: page.text.slice(0, 5000) });
          } catch { /* 单篇失败跳过 */ }
          await new Promise((r) => setTimeout(r, 800)); // 反爬间隔
        }
      } catch { /* 抓取层失败 */ }
      if (!pages.length) {
        return { ok: false, error: `找到帖子但正文抓取失败（可能需登录），可手动打开：\n${posts.slice(0, 3).map((p) => `- ${p.title}\n  ${p.url}`).join("\n")}` };
      }
      // 3) LLM 汇总高频考点（抓到的页面文本是外部数据——包裹为不可信内容再喂 LLM，防提示注入）
      const raw = pages.map((p) => `【${p.title}】\n${p.text}`).join("\n\n---\n\n").slice(0, 9000);
      const material = sanitizeExternal(raw).wrapped;
      try {
        const data = await llmChat(
          [
            { role: "system", content: "你是求职情报分析师，只依据给定面经内容提炼，页面没有的不编造。只输出合法 JSON。" },
            { role: "user", content: `下面是「${comp}」的面经内容，请提炼：
- topTopics：该公司高频考点 TOP 5（具体知识点）
- patterns：2-3 条面试特点（如：重手写、爱追问项目、有笔试环节）
- advice：2-3 条准备建议（结合薄弱点优先补强）

只输出 JSON：{"topTopics":[""],"patterns":[""],"advice":[""]}

【面经内容】
${material}` },
          ],
          { maxTokens: 1200, temperature: 0.2, role: "company-intel" }
        );
        const parsed = extractJson(getReplyText(data));
        if (!parsed || !Array.isArray(parsed.topTopics)) return { ok: false, error: "面经汇总失败（LLM 返回异常）" };
        return {
          ok: true,
          company: comp,
          topTopics: (parsed.topTopics || []).slice(0, 5),
          patterns: (parsed.patterns || []).slice(0, 3),
          advice: (parsed.advice || []).slice(0, 3),
          sources: pages.map((p) => ({ title: p.title, url: p.url })),
          hint: "考点已汇总，可把高频考点加入学习清单（告诉真白'把以上考点加入清单'）",
        };
      } catch (e) {
        return { ok: false, error: `面经汇总失败: ${String(e?.message || e).slice(0, 120)}` };
      }
    },
  },
];
