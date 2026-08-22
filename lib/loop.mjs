// 闭环驱动引擎：方向 ↔ 学习 ↔ 岗位 ↔ 面试 多向驱动（非单向管道）
//
// 节点：direction(方向) / learning(学习) / jobs(岗位) / interview(面试)
// 驱动边（→ = 谁驱动谁产生什么）：
//   direction → jobs       jobs.mjs 简历/方向匹配推荐（已有）
//   interview → learning   interview.mjs 薄弱点回流学习清单/复习卡（已有）
//   learning → interview   agent get_study_plan 优先考未完成项（已有）
//   jobs → learning        deriveStudyFromJob：岗位 JD 反推考点 → 学习清单   ★本引擎
//   jobs → interview       startInterviewForJob：按岗位 JD 出题（focus=考点）★本引擎
//   direction → learning   learnForDirection：按方向搜面经提炼考点 → 清单    ★本引擎
//   learning → jobs        suggestJobsForWeakPoints：短板感知岗位建议        ★本引擎
//   全节点 → 下一步        loopSuggest：规则引擎给出当前最该做的事           ★本引擎
//
// 设计原则：LLM 只用于"提炼"（JD 考点/面经考点），"决策"（建议/匹配）用规则——快、省、可测
import { addPlanItems, getPlan } from "./study.mjs";
import { startInterview } from "./interview.mjs";
import { getJobs, getTargetDirection } from "./jobs.mjs";
import { memory } from "./memory.mjs";
import { getWeakKps } from "./knowledge.mjs";
import { review } from "./review.mjs";
import { getFocusStats } from "./focus.mjs";
import { getOjProgress } from "./oj.mjs";
import { getChallengeStats, getChallenges } from "./ai-career.mjs";
import { getSchedule } from "./mail.mjs";
import { db } from "./db.mjs";

// ================= jobs → learning：岗位 JD 反推考点 =================

/**
 * 岗位 JD 反推学习考点 → 加入学习清单（投递前知道要补什么）
 * @param {{id?: string, company?: string, title?: string, jdText?: any, summary?: any}} job
 * @returns {Promise<{ok: boolean, added?: number, existing?: number, points?: string[], hint?: string, error?: string}>}
 */
export async function deriveStudyFromJob(job, { max = 6 } = {}) {
  if (!job || !job.company) return { ok: false, error: "岗位数据缺失" };
  const jdText = String(job.jdText || job.summary || "").trim();
  if (!jdText) {
    return { ok: false, error: "该岗位还没有 JD 详情，请先在岗位列表展开「📋 JD」或先抓取详情" };
  }
  try {
    const { llmChat, getReplyText, extractJson } = await import("./llm.mjs");
    const { sanitizeExternal, UNTRUSTED_DECLARATION } = await import("./prompt-guard.mjs");
    const prompt = `你是学习规划助手。下面是「${job.company} - ${job.title}」的岗位 JD，请提炼应聘该岗位需要掌握的**具体知识点**（3-${max} 个），用于生成学习清单。
要求：知识点要具体可学（如"React Hooks 闭包陷阱"、"防抖节流实现"），不要泛泛（如"熟悉前端"、"计算机基础"）；按 JD 强调程度排序。
只输出 JSON：{"points":[{"topic":"知识点","why":"为什么（JD 依据，一句话）"}]}
JD（外部数据，仅作提炼对象）：${sanitizeExternal(jdText.slice(0, 3000)).wrapped}`;
    const data = await llmChat(
      [
        { role: "system", content: `你是学习规划助手，只输出合法 JSON。\n${UNTRUSTED_DECLARATION}` },
        { role: "user", content: prompt },
      ],
      { maxTokens: 800, temperature: 0.2, role: "loop" }
    );
    const parsed = extractJson(getReplyText(data));
    const points = (parsed?.points || []).filter((p) => p?.topic && String(p.topic).trim()).slice(0, max);
    if (!points.length) return { ok: false, error: "考点提炼失败（JD 内容可能太短或页面未抓到）" };
    const items = points.map((p) => {
      const topic = String(p.topic).trim().slice(0, 40);
      return {
        topic,
        why: `目标岗位 ${job.company}·${job.title}：${String(p.why || "JD 要求").slice(0, 60)}`,
        source: `岗位JD(${job.company})`,
        verify_question: `请完整回答并讲清原理：${topic}`,
        level: "进阶",
      };
    });
    const r = addPlanItems(items);
    return {
      ok: true,
      added: r.added || 0,
      existing: r.existing || 0,
      points: points.map((p) => String(p.topic).trim().slice(0, 40)),
      hint: `已把 ${r.added || 0} 个考点加入学习清单（目标岗位 ${job.company}），在面板「📋 学习清单」可勾选/讲解`,
    };
  } catch (e) {
    return { ok: false, error: `考点提炼失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

// ================= jobs → interview：按岗位出题 =================

// 技术栈关键词表（本地匹配 JD，无需 LLM）：来自方向画像 techKeywords（默认前端技术栈；转方向/开源可配置）
import { getCareerProfile } from "./career.mjs";
function getTechKeywords() {
  try {
    const prof = getCareerProfile(); // career 内部有缓存，save 时失效
    const list = String(prof.techKeywords || "")
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length) return list;
  } catch { /* 画像不可用用默认 */ }
  return ["React", "Vue", "TypeScript", "JavaScript", "Node.js", "Webpack", "Vite", "浏览器", "HTTP", "CSS", "HTML5", "小程序", "性能优化", "工程化", "微前端", "SSR", "Next.js", "WebSocket", "Canvas", "WebGL", "可视化", "AI Agent", "大模型", "Prompt", "MCP", "Electron", "Flutter", "RN", "安全", "XSS", "跨域", "事件循环", "闭包", "Promise", "虚拟DOM", "diff", "hooks", "状态管理", "Redux", "Pinia", "测试", "CI/CD", "Docker", "K8s", "GraphQL", "数据库", "MySQL", "Redis", "Nginx"];
}

/** 从 JD 文本提取技术关键词（本地词表匹配，无 LLM 开销；词表跟随方向画像） */
export function extractTechKeywords(text) {
  const s = String(text || "");
  if (!s) return [];
  return getTechKeywords().filter((k) => new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(s));
}

/**
 * 按岗位开模拟面试：面试官 focus = 岗位 JD 考点（岗位 → 面试 驱动）
 * @returns {Promise<{ok: boolean, job?: object, error?: string}>}
 */
export async function startInterviewForJob(jobId) {
  const job = getJobs().find((j) => j.id === String(jobId));
  if (!job) return { ok: false, error: `岗位不存在: ${jobId}` };
  const focusParts = [`岗位：${job.company} ${job.title}`];
  const jdText = String(job.jdText || "").trim();
  if (jdText) {
    const techs = extractTechKeywords(jdText);
    if (techs.length) focusParts.push(`按目标岗位考察：${techs.slice(0, 6).join("、")}`);
  }
  try {
    const r = await startInterview({ position: job.title, focus: focusParts.join("；") });
    return { ok: true, ...r, job: { id: job.id, company: job.company, title: job.title } };
  } catch (e) {
    return { ok: false, error: `按岗位面试启动失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

// ================= direction → learning：按方向学习 =================

/**
 * 按方向生成学习清单：本地知识库命中优先；无命中 → 搜面经 → 提炼考点
 * @returns {Promise<{ok: boolean, added?: number, points?: string[], from?: string, hint?: string, error?: string}>}
 */
export async function learnForDirection(direction, { max = 5 } = {}) {
  const dir = String(direction || "").trim();
  if (!dir) return { ok: false, error: "方向不能为空（如：前端 / React / AI Agent 前端）" };
  // 1) 本地知识库命中 → 直接学（快且准）
  try {
    const { searchKnowledge } = await import("./rag.mjs");
    const hits = await searchKnowledge(dir, 3);
    if (hits.length) {
      return {
        ok: true,
        from: "knowledge",
        points: hits.map((h) => h.title).slice(0, max),
        hint: `本地知识库已有「${dir}」相关 ${hits.length} 条内容（面经讲解/复习卡/文档），可在面板「🔍 知识库」直接学习，无需重新生成`,
      };
    }
  } catch { /* 知识库不可用走搜索 */ }
  // 2) 搜面经 → 提炼考点
  try {
    const { toolSearchPosts } = await import("./agent.mjs");
    const { fetchPage } = await import("./fetch-page.mjs");
    const { detectQuestions } = await import("./ai.mjs");
    const r = await toolSearchPosts(dir, "auto");
    const posts = (r.results || []).slice(0, 3);
    if (!posts.length) return { ok: false, error: `没找到「${dir}」相关面经，换个方向词试试` };
    const topics = [];
    for (const p of posts) {
      try {
        const page = await fetchPage(p.url, { maxTextChars: 6000, waitUntil: "domcontentloaded" });
        if (page.invalid || !page.text) continue;
        const dq = await detectQuestions({ title: page.title || p.title, text: page.text.slice(0, 6000) });
        for (const q of (dq.questions || []).slice(0, 3)) {
          const t = String(q.question || "").replace(/[（(].*?[)）]/g, "").trim().slice(0, 40);
          if (t && !topics.includes(t)) topics.push(t);
        }
        if (topics.length >= max) break;
      } catch { /* 单篇失败跳过 */ }
    }
    if (!topics.length) {
      return { ok: false, error: `搜到「${dir}」面经但未提炼出具体题目（多为攻略文），换个方向词试试` };
    }
    const items = topics.slice(0, max).map((t) => ({
      topic: t,
      why: `按方向「${dir}」学习：来自最新面经`,
      source: `方向学习(${dir})`,
      verify_question: `请完整回答并讲清原理：${t}`,
      level: "进阶",
    }));
    const r2 = addPlanItems(items);
    return {
      ok: true,
      from: "search",
      added: r2.added || 0,
      points: topics.slice(0, max),
      hint: `已按「${dir}」方向把 ${r2.added || 0} 个面经考点加入学习清单`,
    };
  } catch (e) {
    return { ok: false, error: `方向学习失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

// ================= learning → jobs：短板感知岗位建议 =================

/** 主题命中检测（子串 + 常见别名归一化） */
function containsTopic(text, topic) {
  const t = String(topic || "").toLowerCase().trim();
  if (!t || t.length < 2) return false;
  const s = String(text || "").toLowerCase();
  if (s.includes(t)) return true;
  // 常见写法归一化：React Hooks → react hooks；虚拟DOM → 虚拟dom
  const norm = (x) => x.replace(/[ _-]/g, "").replace(/dom/gi, "dom");
  return norm(s).includes(norm(t));
}

/**
 * 短板感知岗位建议：不要求短板的岗位可直接投；涉及短板的岗位需先补强
 * @returns {{ok: boolean, weak: string[], canApply: any[], needStudy: any[], hint?: string}}
 */
export function suggestJobsForWeakPoints(limit = 10) {
  const weak = [];
  for (const w of memory.getTrustedWeakPoints(10)) weak.push(w.topic);
  try {
    for (const k of getWeakKps(5)) weak.push(k.title); // 知识树薄弱项
  } catch { /* 知识树不可用时忽略 */ }
  if (!weak.length) {
    return { ok: true, weak: [], canApply: [], needStudy: [], hint: "暂无薄弱点——保持学习节奏，薄弱点会在复盘/面试后自动回流" };
  }
  const jobs = getJobs().filter((j) => j.status === "new"); // 未处理岗位才是"可投/需补学"候选（已投/待笔试/完成都排除）
  const canApply = [];
  const needStudy = [];
  for (const j of jobs) {
    const text = `${j.title} ${j.summary || ""} ${j.jdText || ""}`;
    const hit = weak.filter((w) => containsTopic(text, w));
    if (hit.length) needStudy.push({ id: j.id, company: j.company, title: j.title, weakHits: hit.slice(0, 3), applyUrl: j.applyUrl });
    else canApply.push({ id: j.id, company: j.company, title: j.title, applyUrl: j.applyUrl });
  }
  return {
    ok: true,
    weak: weak.slice(0, 10),
    canApply: canApply.slice(0, limit),
    needStudy: needStudy.slice(0, limit),
    hint: `短板 ${weak.length} 个：${canApply.length} 个岗位不要求短板可直接投；${needStudy.length} 个岗位涉及短板，建议先补强再投`,
  };
}

/** 知识树薄弱项缓存注入（保留兼容入口；当前实现已静态 import getWeakKps，无需预热） */
export function setWeakKpCache(list) {
  return list;
}

// ================= 投递 → 备战（投递成功后记录备战公司） =================
const APPLIED_KEY = "applied_companies";

/** 记录投递后的备战公司（去重置顶，保留最近 10 家） */
export function recordAppliedCompany(company) {
  const c = String(company || "").trim().slice(0, 30);
  if (!c) return { ok: false, error: "公司名缺失" };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(APPLIED_KEY);
    const map = {};
    try { if (row?.value != null) Object.assign(map, JSON.parse(String(row.value))); } catch { /* ignore */ }
    // 同毫秒单调递增：连续记录在同一毫秒内时保证"后写的排前面"
    // （纯 Date.now() 同毫秒碰撞 → 排序不稳定；+1ms 对外无感知）
    let ts = Date.now();
    const max = Math.max(0, ...Object.values(map).map(Number));
    if (ts <= max) ts = max + 1;
    map[c] = ts;
    // 保留最近 10 家（按时间排序裁剪）
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const keep = Object.fromEntries(sorted);
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(APPLIED_KEY, JSON.stringify(keep), Date.now());
    return { ok: true, companies: Object.keys(keep) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 备战公司列表 [{company, appliedAt}] */
export function getAppliedCompanies() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(APPLIED_KEY);
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value));
      if (parsed && typeof parsed === "object") {
        return Object.entries(parsed).map(([company, appliedAt]) => ({ company, appliedAt: Number(appliedAt) || 0 }))
          .sort((a, b) => b.appliedAt - a.appliedAt);
      }
    }
  } catch { /* ignore */ }
  return [];
}

// ================= 全节点 → 下一步：闭环建议（规则引擎） =================

/** 复习到期数（review.getStats，读失败返回 0） */
function reviewDueCount() {
  try {
    const s = review.getStats ? review.getStats() : null;
    return s?.due || 0;
  } catch { /* 复习表不可用时返回 0 */ }
  return 0;
}

/**
 * 闭环状态汇总 + 规则建议（不耗 LLM：决策用规则，快且可测）
 * 消费全部节点数据：方向/清单/薄弱点/岗位/面试 + 复习到期/专注/刷题/投递备战/面试日程
 * 优先级：面试日程 > 复习到期 > 薄弱点 > 清单 > 投递备战 > 岗位 > 刷题/专注 > 方向
 */
export function loopSuggest() {
  const direction = getTargetDirection() || "";
  const plan = getPlan();
  const todo = (plan.items || []).filter((i) => !i.done).length;
  const weak = memory.getTrustedWeakPoints(5).map((w) => w.topic);
  const jobs = getJobs();
  const open = jobs.filter((j) => j.status === "new").length;
  const applied = jobs.filter((j) => j.status === "ready" || j.status === "ready_bishi" || j.status === "done").length; // 已投递口径（含待笔试/完成）
  const history = memory.getInterviewHistory();
  const last = history[history.length - 1] || null;
  const dueCards = reviewDueCount();
  const focus = safeFocusStats();
  const ojDone = safeOjDone();
  const challengeStats = safeChallengeStats();
  const challengeLeft = Math.max(0, challengeStats.total - challengeStats.done);
  const appliedCompanies = getAppliedCompanies().map((c) => c.company);
  // 近 48h 面试/笔试日程（最急事项）
  const upcoming = [];
  try {
    const now = Date.now();
    for (const ev of getSchedule() || []) {
      const at = Number(ev?.interviewAt || 0);
      if (at && at >= now && at <= now + 48 * 3600 * 1000) {
        upcoming.push({
          company: String(ev?.company || ""),
          form: String(ev?.form || ""),
          at,
          atText: new Date(at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
        });
      }
    }
  } catch { /* 日程不可用忽略 */ }

  const suggestions = [];
  // 1) 最急：面试日程
  for (const ev of upcoming.slice(0, 2)) {
    suggestions.push(`🎤 ${ev.company}${ev.form ? `（${ev.form}）` : ""} ${ev.atText} 有面试——先热身：搜该公司面经 + 按岗模拟（interview-warmup）`);
  }
  // 2) 复习到期
  if (dueCards > 0) suggestions.push(`🔁 ${dueCards} 张复习卡到期——先复习（答错会自动回流薄弱点）`);
  // 3) 薄弱点
  if (weak.length) suggestions.push(`🔧 补强薄弱点：${weak.slice(0, 3).join("、")}（复习卡/清单/专注目标优先选它）`);
  // 4) 清单未完成
  if (todo > 0) suggestions.push(`📚 学习清单还有 ${todo} 项未完成——投递前先完成，面试被问到的概率高`);
  // 5) 投递备战
  if (appliedCompanies.length) {
    suggestions.push(`📮 已投 ${appliedCompanies.slice(0, 3).join("、")}${appliedCompanies.length > 3 ? ` 等 ${appliedCompanies.length} 家` : ""}——备战：让真白查公司面经 / 把考点加入清单`);
  }
  // 6) 未投岗位
  if (open > 0) suggestions.push(`💼 ${open} 个未投岗位——可先「按岗面试」演练再投，或直接投递`);
  // 7) 刷题/专注状态
  if (ojDone === 0 && focus.minutes === 0) {
    if (challengeLeft > 0) {
      suggestions.push(`💻 今天还没刷题也没专注——打开「专项练习」手写/算法题库做 ${Math.min(3, challengeLeft)} 道（做完自动记进度，答错回流薄弱点）`);
    } else {
      suggestions.push(`💻 今天还没刷题也没专注——开个 25 分钟专注刷几道 TOP101（目标可从清单/薄弱点选）`);
    }
  } else if (focus.minutes > 0 && focus.streak >= 2) {
    suggestions.push(`🔥 已连续专注 ${focus.streak} 天（今天 ${focus.minutes} 分钟），保持节奏`);
  } else if (ojDone > 0 && focus.minutes === 0) {
    suggestions.push(`💻 已刷 ${ojDone} 题——开个 25 分钟专注把错题/薄弱点过一遍`);
  }
  // 7.5) 手写/算法题库进度（专项练习闭环）
  if (challengeLeft > 0 && ojDone === 0 && focus.minutes > 0) {
    suggestions.push(`✍️ 手写/算法题库还剩 ${challengeLeft} 题未做（共 ${challengeStats.total}）——每次专注做 1-2 道，做完自动记进度`);
  }
  // 8) 方向
  if (!direction) suggestions.push("🎯 先设置目标方向（面板「校招」→ 方向），方向驱动岗位匹配与学习");
  // 9) 兜底
  if (!suggestions.length) suggestions.push("🚀 闭环待启动：设置方向 → 生成学习清单 → 逛网搜岗位 → 按岗面试 → 投递");

  return {
    ok: true,
    nodes: {
      direction: direction || "未设置",
      learning: { todo, weak: weak.length, reviewDue: dueCards },
      jobs: { open, applied, total: jobs.length, preparing: appliedCompanies.length },
      interview: last ? { date: last.date, avg: last.avg, rounds: last.rounds } : null,
      focus: { todayMinutes: focus.minutes, streak: focus.streak },
      oj: { done: ojDone },
      challenges: { total: challengeStats.total, done: challengeStats.done, left: challengeLeft },
      upcoming: upcoming.slice(0, 3),
    },
    suggestions,
  };
}

/** 专注统计兜底（focus_sessions 表不可用时返回零值） */
function safeFocusStats() {
  try { return getFocusStats(); } catch { return { minutes: 0, count: 0, distracts: 0, streak: 0 }; }
}

/** 刷题数兜底 */
function safeOjDone() {
  try { return getOjProgress().length; } catch { return 0; }
}

/** 手写/算法题库统计兜底 */
function safeChallengeStats() {
  try { return getChallengeStats(); } catch { return { total: 0, done: 0 }; }
}

// ================= 专注目标推荐（现在最该专注学什么） =================
/** 从到期复习卡 + 薄弱点 + 清单未完成取 top N（专注开始时的目标建议） */
export function suggestFocusGoal(limit = 3) {
  const out = [];
  const push = (text, topic) => { if (out.length < limit && text) out.push({ text: String(text).slice(0, 50), topic: String(topic || "").slice(0, 50) }); };
  // 1) 到期复习卡（遗忘曲线最急）
  try {
    for (const c of review.getDueCards().slice(0, 2)) push(`复习：${c.topic}`, c.topic);
  } catch { /* ignore */ }
  // 2) 薄弱点（failCount 高优先）
  try {
    for (const w of memory.getTrustedWeakPoints(5)) push(`补强：${w.topic}`, w.topic);
  } catch { /* ignore */ }
  // 3) 清单未完成
  try {
    const plan = getPlan();
    for (const i of (plan.items || []).filter((x) => !x.done).slice(0, 3)) push(`学习：${i.topic}`, i.topic);
  } catch { /* ignore */ }
  // 4) 未做的手写/算法题（高频/低难度优先，做完自动记进度）
  try {
    for (const c of getChallenges({ done: false }).sort((a, b) => (b.frequency - a.frequency) || (a.difficulty - b.difficulty)).slice(0, 2)) {
      push(`刷题：${c.title}`, c.title);
    }
  } catch { /* ignore */ }
  return out.slice(0, limit);
}
