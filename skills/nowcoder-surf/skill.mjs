// nowcoder-surf：自主逛牛客（牛客逛完强化方案任务 2）
// 从"基础爬虫"到"逛"：围绕用户目标自主决策——价值判断 / 线索扩展 / 逛完判定 / 记忆去重 / 失败不漂移
// 工具组合：fetch_nowcoder_user（抓全用户动态）+ search_posts（搜面经）+ 归档（学习清单/复习卡）
import { llmChat, getReplyText } from "../../lib/llm.mjs";
import { toolFetchNowcoderUser } from "../../lib/tools/impl-search.ts";

export const name = "nowcoder-surf";
export const description = "自主逛牛客：围绕目标逛用户/面经，价值判断 + 线索扩展 + 逛完判定 + 汇报（不是固定 URL 爬虫）";

/**
 * 逛的决策循环（单用户完整流程）：
 * 观察（抓全动态）→ 每篇 LLM 价值判断 → 高/中价值提炼归档 → 线索扩展（公司/牛友/技术栈）→ 逛完判定 → 汇报
 * @param {{ userId: string, goal: string, maxPages?: number }} args 起点用户 + 用户目标
 * @returns {Promise<{ok: boolean, report?: string, error?: string}>} 逛完汇报
 */
async function surfNowcoder({ userId, goal = "秋招面经", maxPages = 5 }) {
  const uid = String(userId || "").trim();
  if (!/^\d+$/.test(uid)) return { error: "userId 必须是数字（牛客用户主页 URL 里的数字）" };
  // ① 观察：抓全用户动态（contentPage 循环 + 去重——工具层已固化）
  const data = await toolFetchNowcoderUser({ userId: uid, maxPages });
  if (!data.ok) return { error: data.error };
  const { user, moments, totalPages } = data;
  // 薄弱点闭环工单任务 3：读用户薄弱点（逛网从"泛逛"变"定向补弱"——薄弱点相关 → 高价值）
  let weakTopics = [];
  try {
    const { memory } = await import("../../lib/memory.mjs");
    weakTopics = memory.getTrustedWeakPoints(10).map((w) => w.topic);
  } catch { /* 薄弱点不可用按无薄弱点 */ }
  // ② 价值判断 + ③ 线索扩展（LLM 每篇判断：价值 + 知识点 + 线索；薄弱点注入 prompt）
  const judged = await judgeMoments(moments, goal, weakTopics);
  // ④ 归档：高/中价值 → 学习清单（讲解入口在面板）
  // 任务 3：薄弱点匹配（similarity weak）→ 优先入清单（level 必会 + 标注"薄弱点定向"）
  let weakHitCount = 0;
  for (const m of judged.highValue) {
    try {
      const { addPlanItems } = await import("../../lib/study.mjs");
      const { similarityRule } = await import("../../lib/similarity.ts");
      const weakHit = weakTopics.some((w) => {
        const r = similarityRule(String(m.topic || ""), String(w || ""), "weak");
        return r.similar && r.score >= 0.5;
      });
      if (weakHit) weakHitCount++;
      addPlanItems([{
        topic: m.topic,
        why: `牛客逛完·${user.nickname || uid} 面经提炼${weakHit ? "（薄弱点定向——优先补强）" : ""}`,
        source: `牛客用户 ${uid}`,
        verify_question: m.title,
        level: weakHit ? "必会" : "必会",
      }]);
    } catch { /* 归档失败不阻塞逛完 */ }
  }
  // ⑤ 逛完判定 + 汇报
  return {
    ok: true,
    report: `逛完用户 ${user.nickname || uid}（${user.identity || "牛友"}）：共 ${moments.length} 篇动态（${totalPages} 页），高价值 ${judged.highValue.length} 篇已归档学习清单（薄弱点定向 ${weakHitCount} 篇），中价值 ${judged.mediumValue.length} 篇，无关 ${judged.lowValue.length} 篇。线索：${judged.leads.length ? judged.leads.join("、") : "无新线索"}。`,
  };
}

/** LLM 批量价值判断（一次调用判断全部——比逐篇调用省 token；返回高/中/低 + 线索）
 * 薄弱点闭环工单任务 3：weakPoints 参数——价值判断 prompt 注入薄弱点列表
 * （薄弱点相关 → 高价值 → 优先提炼归档——逛网从"泛逛"变"定向补弱"） */
async function judgeMoments(moments, goal, weakPoints = []) {
  const _list = moments.map((m, i) => `${i}.【${m.title}】\n${m.content.slice(0, 500)}`).join("\n\n");
  // 薄弱点注入（任务 3：薄弱点相关 → 高价值；权重设计：相关 +2 分，不相关不扣分——不误杀新知识）
  const weakBlock = weakPoints.length
    ? `\n\n【用户薄弱点】（用户答错过/自评不会的知识点——动态涉及这些 → 价值提升为"高"（优先提炼归档）；不涉及不降级，按原标准判断）\n${weakPoints.map((w) => `- ${w}`).join("\n")}`
    : "";
  const prompt = `你是秋招信息筛选助手。用户目标是：${goal}。以下是逛到的 ${moments.length} 篇牛客动态，请逐篇判断价值并提取线索。${weakBlock}

对每篇输出：{"i":序号,"value":"高|中|低|无关","topic":"提炼的知识点（高/中价值时，如'事件循环'）","leads":["线索（公司/牛友/技术栈，如'字节'、'用户12345'，无关则空）"]}

只输出 JSON 数组。`;
  try {
    const data = await llmChat(
      [
        { role: "system", content: "你是严格但高效的秋招信息筛选助手。只输出合法 JSON。" },
        { role: "user", content: prompt },
      ],
      { maxTokens: 2000, temperature: 0.2 }
    );
    const { extractJson } = await import("../../lib/llm.mjs");
    const parsed = extractJson(getReplyText(data));
    const arr = Array.isArray(parsed) ? parsed : [];
    if (!arr.length) throw new Error("LLM 判断结果为空"); // 触发降级（不丢内容）
    const highValue = [], mediumValue = [], lowValue = [];
    const leads = new Set();
    for (const r of arr) {
      const m = moments[Number(r?.i)];
      if (!m) continue;
      const v = String(r?.value || "");
      const item = { title: m.title, topic: String(r?.topic || m.title).slice(0, 40) };
      if (v === "高") highValue.push(item);
      else if (v === "中") mediumValue.push(item);
      else lowValue.push(item);
      for (const l of Array.isArray(r?.leads) ? r.leads : []) {
        if (l && String(l).trim()) leads.add(String(l).trim().slice(0, 30));
      }
    }
    return { highValue, mediumValue, lowValue, leads: [...leads].slice(0, 5) };
  } catch {
    // LLM 判断失败 → 降级：全部按中价值（不丢内容，但标注未判断）
    return { highValue: [], mediumValue: moments.map((m) => ({ title: m.title, topic: m.title.slice(0, 40) })), lowValue: [], leads: [] };
  }
}

export const tools = [
  {
    name: "surf_nowcoder",
    description: "自主逛牛客用户：抓全动态 → 价值判断 → 高价值归档学习清单 → 线索扩展 → 逛完汇报（围绕用户目标，不是固定爬虫）",
    parameters: {
      type: "object",
      properties: {
        userId: { type: "string", description: "牛客用户 ID（主页 URL 里的数字，如 500303394）" },
        goal: { type: "string", description: "用户目标（如'字节前端面经'），用于价值判断" },
        maxPages: { type: "number", description: "最多逛几页（默认 5）" },
      },
      required: ["userId"],
    },
    permission: "auto",
    run: surfNowcoder,
  },
];
