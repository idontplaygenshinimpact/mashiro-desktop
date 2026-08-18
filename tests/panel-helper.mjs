// tests/panel-helper.mjs —— 面板 jsdom 测试公共设施
// 真实加载 panel.html + 全部 panel 脚本（顺序与 <script> 一致），提供可覆盖的 kanban/fetch mock。
// 背景：面板 UI 交互层曾是测试真空（focus-goal 缺失、学习按钮没绑事件等 DOM/交互 bug 全漏网），
//       jsdom 测试是这类回归的护栏。注意：
//       - 顶层有轮询 setInterval（loadCrawlData 5s 等），收尾必须清定时器再 close（否则进程挂住）
//       - jsdom 无 canvas 2d context，renderIvSummary 等画图路径需要 stub getContext
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer");
const html = readFileSync(path.join(renderer, "panel.html"), "utf8");
const SCRIPTS = ["panel-core.js", "panel-study.js", "panel-chat.js", "panel-jobs.js", "panel-rest.js"];
const srcs = SCRIPTS.map((f) => readFileSync(path.join(renderer, f), "utf8"));

/** 学习清单样例：待学×2 / 学习中×1 / 已掌握×1（覆盖全部状态流） */
export const SAMPLE_PLAN = {
  ok: true,
  plan: {
    items: [
      { id: "1", topic: "React Hooks 原理", why: "面试必问", level: "必会", done: false, hasFile: true, reviewed: false },
      { id: "2", topic: "事件循环与微任务", why: "高频", level: "必会", done: false, hasFile: false, reviewed: false },
      { id: "3", topic: "性能优化实战", why: "进阶", level: "进阶", done: false, hasFile: false, reviewed: false },
      { id: "4", topic: "已完成主题", why: "旧项", level: "拓展", done: true, hasFile: true, reviewed: true },
    ],
  },
};

const INV_START = {
  ok: true, round: 1, roundType: "开场与自我介绍",
  question: "请先做个自我介绍，并讲讲你的项目经历",
  totalRounds: 9, weakQueue: [], depth: 0,
  dimension: "表达与项目梳理", basis: "开场固定流程", criteria: "结构清晰", boundary: "2 分钟以内",
};

/** 默认 mock（测试可用 overrides 覆盖单个方法） */
function defaultKanban(overrides = {}) {
  const okJson = () => ({ ok: true, active: false, phase: "idle", todayMinutes: 0, week: [], goal: "", items: [], list: [], goals: [], content: "测试讲解内容", topic: "测试讲解", fromFile: true });
  const kanban = { notify() {}, speechToText: async () => ({ ok: false }) };
  for (const m of ["chat", "chatHistory", "getData", "getMastery", "getObservability", "getStats", "interviewHistory", "interviewNotes", "mascotModels", "mascotSetModel", "openOutput", "parseResumeFile", "patrolConfig", "patrolRun", "playScene", "ragConfig", "restartApp", "reviewDue", "runDiscover", "setGlobalVoice", "setVoiceEnabled", "speak", "studyAnswer", "studyCheck", "studyCluster", "studyConsolidate", "studyDetailAppend", "studyGenerate", "studyReview"]) {
    kanban[m] = async () => okJson();
  }
  kanban.invStart = async () => INV_START;
  kanban.invAnswer = async () => ({
    ok: true, scores: { tech: 80, expr: 70, depth: 60, edge: 50, reflect: 40 }, total: 60, comment: "不错",
    finished: false, question: "讲讲 React Fiber", roundType: "技术轮", dimension: "原理", basis: "追问",
    criteria: "c", boundary: "b", weakHit: false, weakTopic: "",
  });
  kanban.invEnd = async () => ({ ok: true, report: "## 面试复盘（前端）\n### 总体评价\n准备度良好", weakTotal: 0, weakCovered: 0, weakCoveredTopics: [], hint: "" });
  kanban.studyPlan = async () => SAMPLE_PLAN;
  kanban.studyDetailStream = async (_id, onUpdate) => {
    onUpdate?.("测试讲解内容");
    return { fromFile: true, content: "测试讲解内容", topic: "测试讲解" };
  };
  kanban.reviewDue = async () => ({ ok: true, due: [], stats: {}, trend: { trend: [], streak: 0 }, todayReviewed: [] });
  kanban.reviewSubmit = async () => ({ ok: true, nextDue: null, emotion: "" });
  // 应用用例级覆盖（必须在 eval 之前生效——顶层 loadStudyPlan 等启动即跑）
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "function") kanban[k] = v;
    else if (v !== undefined) kanban[k] = async () => v; // 普通对象值 → 直接作为返回
  }
  return kanban;
}

/**
 * 启动面板（jsdom 加载完整 HTML + 脚本）
 * @param {object} overrides 覆盖 kanban 方法（如 { studyPlan: {...} }）
 * @returns {{dom, window, calls, kanban}}
 */
export function bootPanel(overrides = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1:8899/panel.html", pretendToBeVisual: true });
  const { window } = dom;
  const timerIds = [];
  window.setInterval = (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timerIds.push(id); return id; };
  window.setTimeout = (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timerIds.push(id); return id; };
  window.clearAllTimers = () => { for (const id of timerIds) clearTimeout(id); };
  // jsdom 无 canvas 2d：stub 掉（drawIvRadar 等画图路径不崩）
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
  const calls = [];
  const kanban = defaultKanban(overrides);
  window.kanban = kanban;
  window.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET" });
    return { ok: true, json: async () => ({ ok: true, items: [], list: [], plan: SAMPLE_PLAN.plan }) };
  };
  window.eval(srcs.join("\n"));
  return { dom, window, calls, kanban };
}

/** 用例包装：跑完排空异步链 → 停轮询 → 关 window（防异步泄漏挂住测试） */
export async function withPanel(fn, overrides = {}) {
  const ctx = bootPanel(overrides);
  try { return await fn(ctx); }
  finally {
    await new Promise((r) => setTimeout(r, 30));
    ctx.window.clearAllTimers();
    ctx.dom.window.close();
  }
}

/** 等待微任务 + 短定时（面板异步渲染用） */
export const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
