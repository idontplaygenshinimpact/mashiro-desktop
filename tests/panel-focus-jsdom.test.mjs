// tests/panel-focus-jsdom.test.mjs —— 面板关键交互 jsdom 回归测试
// 背景：
//   1) focus-goal 输入框缺失 → 点「🍅 25 分钟」报 "Cannot read properties of null (reading 'value')"
//   2) 学习清单主列表渲染后未调用 bindPlanItems → 点「📖 学习」毫无反应（按钮没绑事件）
// 本测试真实加载 panel.html + 全部 panel 脚本（jsdom），模拟点击，断言不崩且行为正确。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import test from "node:test";
import assert from "node:assert/strict";

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer");
const html = readFileSync(path.join(renderer, "panel.html"), "utf8");
// 与 panel.html 的 <script> 加载顺序一致（全局词法共享，跨文件函数依赖）
const SCRIPTS = ["panel-core.js", "panel-study.js", "panel-chat.js", "panel-jobs.js", "panel-rest.js"];
const srcs = SCRIPTS.map((f) => readFileSync(path.join(renderer, f), "utf8"));

const SAMPLE_PLAN = {
  ok: true,
  plan: {
    items: [
      { id: "1", topic: "React Hooks 原理", why: "面试必问", level: "必会", done: false, hasFile: true, reviewed: false },
      { id: "2", topic: "事件循环", why: "基础", level: "必会", done: false, hasFile: false, reviewed: false },
    ],
  },
};

function bootPanel() {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1:8899/panel.html", pretendToBeVisual: true });
  const { window } = dom;
  const timerIds = [];
  // 劫持定时器并记录：面板顶层有轮询 setInterval（loadCrawlData 5s / checkApprovals 2s 等），
  // 不清理会在测试结束后继续触发（window 已 close → document undefined → unhandledRejection）
  window.setInterval = (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timerIds.push(id); return id; };
  window.setTimeout = (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timerIds.push(id); return id; };
  window.clearAllTimers = () => { for (const id of timerIds) clearTimeout(id); };
  const calls = [];
  const okJson = () => ({ ok: true, active: false, phase: "idle", todayMinutes: 0, week: [], goal: "", items: [], list: [], goals: [], plan: SAMPLE_PLAN.plan, content: "测试讲解内容", topic: "测试讲解", fromFile: true });
  // 通用安全 stub（真实环境由 preload 注入；测试只关心被点击的路径）
  const kanban = { notify() {}, speechToText: async () => ({ ok: false }) };
  for (const m of ["chat", "chatHistory", "getData", "getMastery", "getObservability", "getStats", "interviewHistory", "interviewNotes", "invAnswer", "invEnd", "invStart", "mascotModels", "mascotSetModel", "openOutput", "parseResumeFile", "patrolConfig", "patrolRun", "playScene", "ragConfig", "restartApp", "reviewDue", "reviewSubmit", "runDiscover", "setGlobalVoice", "setVoiceEnabled", "speak", "studyAnswer", "studyCheck", "studyCluster", "studyConsolidate", "studyDetailAppend", "studyGenerate", "studyReview"]) {
    kanban[m] = async () => okJson();
  }
  kanban.studyPlan = async () => SAMPLE_PLAN;
  kanban.studyDetailStream = async (_id, onUpdate) => {
    onUpdate?.("测试讲解内容");
    return { fromFile: true, content: "测试讲解内容", topic: "测试讲解" };
  };
  // 模拟面试：完整首问响应（含全部展示字段）
  kanban.invStart = async () => ({
    ok: true, round: 1, roundType: "开场与自我介绍",
    question: "请先做个自我介绍，并讲讲你的项目经历",
    totalRounds: 9, weakQueue: [], depth: 0,
    dimension: "表达与项目梳理", basis: "开场固定流程", criteria: "结构清晰", boundary: "2 分钟以内",
  });
  window.kanban = kanban;
  window.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || "GET" });
    return { ok: true, json: async () => okJson() };
  };
  // 真实浏览器中 <script> 顶层 const 是全局词法绑定、跨文件可见；jsdom 的 window.eval
  // 每次独立作用域，故拼接一次执行（顺序与 HTML 一致）
  window.eval(srcs.join("\n"));
  return { dom, window, calls };
}

const withPanel = async (fn) => {
  const { dom, window, calls } = bootPanel();
  try { return await fn({ window, calls }); }
  finally {
    // 排空顶层异步链（loadFocus/loadStudyPlan 等 fetch→render 的微任务），再停轮询、关 window
    await new Promise((r) => setTimeout(r, 30));
    window.clearAllTimers();
    dom.window.close();
  }
};

test("点击「🍅 25 分钟」不再崩溃，且正确请求 /api/focus/start", () => {
  withPanel(({ window, calls }) => {
    const btn = window.document.getElementById("focus-25");
    assert.ok(btn, "focus-25 按钮应存在");
    const goalInput = window.document.getElementById("focus-goal");
    assert.ok(goalInput, "focus-goal 输入框应存在（此前缺失导致 null.value 崩溃）");
    goalInput.value = "刷完动态规划 5 题";
    assert.doesNotThrow(() => btn.click());
    const start = calls.find((c) => c.url.includes("/api/focus/start"));
    assert.ok(start, "应请求 /api/focus/start");
    assert.equal(start.method, "POST");
  });
});

test("学习清单主列表「📖 学习」按钮有响应：点击打开讲解弹窗", async () => {
  withPanel(async ({ window }) => {
    await new Promise((r) => setTimeout(r, 60)); // 等顶层 loadStudyPlan 异步渲染完成
    const list = window.document.getElementById("study-list");
    assert.ok(list, "study-list 存在");
    const learnBtn = list.querySelector(".s-learn");
    assert.ok(learnBtn, "主列表应渲染「学习」按钮（清单有数据时）");
    const overlay = window.document.getElementById("study-detail-overlay");
    assert.ok(overlay, "讲解弹窗容器存在");
    assert.ok(overlay.classList.contains("hidden"), "初始弹窗隐藏");
    assert.doesNotThrow(() => learnBtn.click());
    await new Promise((r) => setTimeout(r, 30)); // 等异步详情加载
    assert.ok(!overlay.classList.contains("hidden"), "点击学习后弹窗应打开（此前按钮无事件 → 没反应）");
  });
});

test("模拟面试开始 → 问题正常显示（iv-answer-area 曾是 class 被当 id 用，修复前此处必崩 → 问题永远不显示）", async () => {
  withPanel(async ({ window }) => {
    const startBtn = window.document.getElementById("iv-start");
    assert.ok(startBtn, "开始面试按钮存在");
    assert.doesNotThrow(() => startBtn.click());
    await new Promise((r) => setTimeout(r, 30)); // 等 invStart 异步返回 + 渲染
    const q = window.document.getElementById("iv-question");
    assert.equal(q.textContent, "请先做个自我介绍，并讲讲你的项目经历", "问题应显示在面板上（此前 showQuestion 从不执行）");
    const area = window.document.getElementById("iv-answer-area");
    assert.notEqual(area.style.display, "none", "回答区应显示（iv-answer-area 的 display 操作不应崩）");
    assert.match(window.document.getElementById("iv-status").textContent, /面试中/, "状态切到面试中");
  });
});

test("点击「🍅 45 分钟」与「🚫 名单」不崩", () => {
  withPanel(({ window }) => {
    assert.doesNotThrow(() => window.document.getElementById("focus-45").click());
    assert.doesNotThrow(() => window.document.getElementById("focus-blacklist-toggle").click());
  });
});
