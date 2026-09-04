// 工具实现迁出（第二轮优化 ④）：executeTool switch 内联工具 → 独立执行函数
// 只迁"工具实现"；权限门禁/策略拦截/参数校验/审计/死循环检测等调度逻辑留在 agent.mjs executeTool 外层
// 红线：不 import agent.mjs（避免循环依赖）；返回结构契约 {ok/error/hint} 与 switch 完全一致
import { memory } from "../memory.mjs";
import { wrapUntrusted } from "../prompt-guard.mjs";
import { searchWeb } from "../web-search.mjs";
import { withRetry } from "./exec-utils.mjs";
import * as interviewApi from "../interview.mjs";

/** search_knowledge：本地 RAG 知识库（命中内容来自爬虫，包裹为不可信数据）
 * @param {{query?: string, topK?: number}} [args] 检索词 + 条数
 * @returns {Promise<{ok: boolean, hits: Array<any>, message: string}|{error: string, hint?: string}>} 命中结果
 */
export async function execSearchKnowledge(args = {}) {
  try {
    const { ragEnabled, searchKnowledge } = await import("../rag.mjs");
    if (!ragEnabled()) return { error: "本地知识库未启用（可在设置中心开启）", hint: "改用 search_posts / web_search 联网获取" };
    const hits = await searchKnowledge(args.query, Math.min(args.topK || 3, 6));
    const wrapped = hits.map((h) => ({ ...h, title: wrapUntrusted(h.title), content: wrapUntrusted(h.content) }));
    return { ok: true, hits: wrapped, message: hits.length ? `本地知识库命中 ${hits.length} 条，可引用其内容回答` : "本地知识库无命中，可改用 search_posts 抓取新内容" };
  } catch (e) {
    return { error: `知识库检索失败: ${e.message.slice(0, 80)}` };
  }
}

/** web_search：实时联网搜索（Bing）——标题/摘要来自外部搜索引擎，包裹为不可信数据
 * @param {{query?: string}} [args] 搜索词
 * @returns {Promise<{ok: boolean, results: Array<{title: string, url: string, snippet: string}>, message: string}>} 搜索结果
 */
export async function execWebSearch(args = {}) {
  const raw = await searchWeb(String(args.query || ""), { limit: 5 });
  // 总字符封顶 ~2000，避免塞爆上下文（保留 1 条也返回，供 LLM 参考）
  let acc = "";
  const picked = [];
  for (const r of raw) {
    const s = `${r.title}\n${r.snippet}\n${r.url}`;
    if (picked.length && acc.length + s.length > 2000) break;
    acc += s;
    picked.push(r);
  }
  if (!picked.length) {
    return { ok: true, results: [], message: "Bing 搜索无结果或网络失败，可改用 search_knowledge（本地知识库）或换关键词重试" };
  }
  const items = picked.map((r) => ({
    title: wrapUntrusted(r.title),
    url: r.url,
    snippet: wrapUntrusted(r.snippet),
  }));
  return { ok: true, results: items, message: `Bing 搜到 ${items.length} 条结果，可据此回答（引用最新信息，标注来源链接）` };
}

/** get_weak_points：合并记忆薄弱点 + 知识点树薄弱项（双源）
 * @returns {Promise<{weakPoints: Array<any>, weakKps?: Array<{topic: string, score: number}>}>} 薄弱点双源
 */
export async function execGetWeakPoints() {
  try {
    const { getWeakKps } = await import("../knowledge.mjs");
    const kps = getWeakKps(5);
    return { weakPoints: memory.getWeakPoints(), weakKps: kps.map((k) => ({ topic: k.title, score: k.score })) };
  } catch {
    return { weakPoints: memory.getWeakPoints() };
  }
}

/** start_interview：开始模拟面试（withRetry 1 次）
 * @param {{position: any, role?: string, resume?: string, focus?: string}} [args] 面试配置
 * @returns {Promise<any>} 面试会话结果
 */
export function execStartInterview(args) {
  return withRetry(() => interviewApi.startInterview(args), 1);
}

/** submit_answer：提交面试回答
 * @param {{answer?: string}} [args] 用户回答
 * @returns {Promise<any>} 判分结果
 */
export function execSubmitAnswer(args = {}) {
  return withRetry(() => interviewApi.submitAnswer(args.answer), 1);
}

/** end_interview：结束面试生成复盘
 * @returns {Promise<any>} 复盘结果
 */
export function execEndInterview() {
  return withRetry(() => interviewApi.endInterview(), 1);
}

/** spawn_subagent：独立子任务执行器（并行由一次消息多个 tool_calls 天然支持）
 * @param {{task?: string, context?: string, name?: string}} [args] 子任务描述
 * @returns {Promise<any>} 子任务结果（结果按不可信数据包裹）
 */
export async function execSpawnSubagent(args = {}) {
  const { runSubagent } = await import("../subagent.mjs");
  const r = await withRetry(() => runSubagent(args), 0);
  // 子任务 context 可能含外部内容（主 agent 抓的页面）——其结果按不可信数据包裹回填，
  // 防注入经 subagent 链路二次传播进主对话
  if (r?.ok && typeof r.result === "string") r.result = wrapUntrusted(r.result);
  return r;
}

/** job_search_platform：招聘平台搜岗 → 入库（agent 与 widget 共用 searchAndStoreJobs）
 * @param {{platform?: string, keyword?: string, limit?: number}} [args] 平台/关键词/条数
 * @returns {Promise<any>} 搜岗入库结果
 */
export async function execJobSearchPlatform(args = {}) {
  try {
    const { ensurePlatforms, searchAndStoreJobs } = await import("../job-platforms.mjs");
    await ensurePlatforms();
    const r = await searchAndStoreJobs(args.platform, args.keyword, {
      storeLimit: Number.isFinite(Number(args.limit)) ? Math.min(Math.max(Number(args.limit), 1), 30) : 15,
    });
    // 结果里的标题来自外部平台，包裹为不可信数据
    if (r.ok && r.jobs?.length) {
      r.jobs = r.jobs.map((j) => ({ ...j, title: wrapUntrusted(j.title), company: wrapUntrusted(j.company) }));
    }
    return r;
  } catch (e) {
    return { error: `平台搜索异常: ${e.message}` };
  }
}

/** job_apply：半自动投递（confirm 权限在 checkToolPermission 已拦；此处执行 + 更新状态 + 备战记录）
 * 副作用边界原样保留：setJobStatus + recordAppliedCompany（横跨 jobs/loop）
 * @param {{platform?: string, url?: string, greeting?: string, jobId?: string}} [args] 投递参数
 * @returns {Promise<any>} 投递结果
 */
export async function execJobApply(args = {}) {
  try {
    const { ensurePlatforms, applyJobOnPlatform } = await import("../job-platforms.mjs");
    await ensurePlatforms();
    const r = await applyJobOnPlatform(args.platform, args.url, { greeting: args.greeting });
    if (r.ok) {
      try {
        const { setJobStatus, getJobs } = await import("../jobs.mjs");
        const { recordAppliedCompany } = await import("../loop.mjs");
        if (args.jobId) {
          // "ready" = 已投递（合法状态，自动记录首次投递时间 applied_at）
          const st = setJobStatus(String(args.jobId), "ready");
          if (st?.ok === false) console.log(`[agent] 投递后状态更新失败: ${st.error}`);
          const job = getJobs().find((j) => j.id === String(args.jobId));
          if (job?.company) recordAppliedCompany(job.company);
        }
      } catch { /* 状态/备战记录失败不影响投递结果 */ }
    }
    return r;
  } catch (e) {
    return { error: `投递异常: ${e.message}` };
  }
}

/** loop_status：闭环状态 + 规则建议（只读，不耗 LLM）
 * @returns {Promise<{ok: boolean, nodes: any, suggestions: any, hint: string}|{error: string}>} 闭环状态
 */
export async function execLoopStatus() {
  try {
    const { loopSuggest } = await import("../loop.mjs");
    const s = loopSuggest();
    return {
      ok: true,
      nodes: s.nodes,
      suggestions: s.suggestions,
      hint: "基于以上建议给用户明确的下一步行动（可组合：先补弱→再演练→再投递）",
    };
  } catch (e) {
    return { error: `闭环状态读取失败: ${e.message}` };
  }
}

/** skill_inspect：技能插件清单（对标 DSH cordis_inspect_list：先查接口再动手）
 * @returns {Promise<{ok: boolean, skills: Array<any>, hookCount: number, summary: string}|{ok: false, hint: string}|{error: string}>} 技能清单
 */
export async function execSkillInspect() {
  try {
    const { loadSkills, inspectSkills } = await import("../skills.mjs");
    await loadSkills();
    const r = inspectSkills();
    if (!r.ok) return { ok: false, hint: r.hint || "技能未加载" };
    const text = r.skills.map((s) => {
      const tools = s.tools.length
        ? s.tools.map((t) => `    - ${t.name}（权限:${t.permission}）`).join("\n")
        : "    - （无工具，纯声明技能）";
      return `  ${s.name}：${s.description || "无说明"}\n${tools}`;
    }).join("\n");
    return {
      ok: true,
      skills: r.skills,
      hookCount: r.hookCount,
      summary: `已加载 ${r.skills.length} 个技能、${r.totalTools} 个工具：\n${text}`,
    };
  } catch (e) {
    return { error: `技能清单读取失败: ${e.message}` };
  }
}

/** ask_user：结构化提问（挂起等用户点选；超时降级）
 * @param {{question?: string, options?: Array<{label: string, description?: string}>, multiSelect?: boolean}} [args] 问题 + 选项
 * @returns {Promise<{ok: boolean, selected: string[], reason: string, hint: string}|{error: string, timeout?: boolean}>} 用户选择
 */
export async function execAskUser(args = {}) {
  try {
    const { askUser } = await import("../ask-user.mjs");
    const opts = (Array.isArray(args.options) ? args.options : [])
      .map((o) => ({ label: String(o?.label ?? o ?? "").slice(0, 60), description: String(o?.description ?? "").slice(0, 200) }))
      .filter((o) => o.label);
    if (!String(args.question || "").trim() || opts.length < 2 || opts.length > 8) {
      return { error: "ask_user 需要 question + 2-8 个选项" };
    }
    const r = await askUser({ question: args.question, options: opts, multiSelect: !!args.multiSelect });
    if (r.timeout) {
      return { error: "用户未在 2 分钟内回答，请基于已有信息继续或换一种问法", timeout: true };
    }
    return { ok: true, selected: r.selected, reason: r.reason || "", hint: "基于用户的选择继续执行" };
  } catch (e) {
    return { error: `提问失败: ${e.message}` };
  }
}

/** plan_mode：计划确认（用户确认后才进入执行，对标 plan mode 的审批关卡）
 * @param {{plan?: string}} [args] 计划内容
 * @returns {Promise<{ok: boolean, approved: boolean, hint: string, modify?: boolean}|{error: string, approved?: boolean}>} 确认结果
 */
export async function execPlanMode(args = {}) {
  try {
    const { askUser } = await import("../ask-user.mjs");
    const plan = String(args.plan || "").trim().slice(0, 4000);
    if (!plan) return { error: "plan_mode 需要计划内容" };
    const r = await askUser({
      question: `📋 执行计划待确认：\n${plan}`,
      options: [
        { label: "✅ 执行", description: "按计划开始执行" },
        { label: "✏️ 修改", description: "告诉真白要改哪里，重新出计划" },
        { label: "❌ 取消", description: "放弃本次计划" },
      ],
      kind: "plan",
    });
    if (r.timeout) return { error: "计划确认超时（视为取消），不要执行", approved: false };
    if (r.selected.includes("✅ 执行")) return { ok: true, approved: true, hint: "用户已确认计划，开始按步骤执行" };
    if (r.selected.includes("✏️ 修改")) return { ok: false, approved: false, modify: true, hint: `用户要求修改：${r.reason || "请询问具体修改点"}。修改后重新提交 plan_mode` };
    return { ok: false, approved: false, hint: `用户取消了计划：${r.reason || "无理由"}。不要执行，询问是否需要调整目标` };
  } catch (e) {
    return { error: `计划确认失败: ${e.message}` };
  }
}

/** todo_init：建立任务清单
 * @param {{items?: Array<any>}} [args] 任务列表
 * @returns {Promise<{ok: boolean, items: Array<any>, hint: string}|{error: string}>} 清单结果
 */
export async function execTodoInit(args = {}) {
  try {
    const { initTodo } = await import("../todo.mjs");
    const r = initTodo(args.items);
    return { ok: true, items: r.items, hint: `任务清单已建立（${r.items.length} 步），每完成一步调用 todo_done 标记` };
  } catch (e) {
    return { error: `清单初始化失败: ${e.message}` };
  }
}

/** todo_done：更新清单进度
 * @param {{index?: number, content?: string, done?: boolean}} [args] 目标项 + 完成状态
 * @returns {Promise<{ok: boolean, items: Array<any>, hint: string}|{error: string, hint?: string}>} 更新结果
 */
export async function execTodoDone(args = {}) {
  try {
    const { updateTodoItem } = await import("../todo.mjs");
    const r = updateTodoItem({ index: args.index, content: args.content, done: args.done !== false });
    return r.ok
      ? { ok: true, items: r.items, hint: "清单进度已更新" }
      : { error: r.error, hint: "检查序号或内容后重试" };
  } catch (e) {
    return { error: `清单更新失败: ${e.message}` };
  }
}
