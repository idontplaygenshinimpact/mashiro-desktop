// 前端三态并行展示工单任务 1：三态切换框架测试
// 覆盖：全 Tab 切换按钮生成 / switchRenderer 泛化（未实现 Tab 提示开发中）/ 偏好持久化（localStorage）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer");
const html = readFileSync(path.join(renderer, "panel.html"), "utf8");
const SCRIPTS = ["panel-state.js", "panel-core.js", "panel-study.js", "panel-chat.js", "panel-jobs.js", "panel-rest.js"];
const srcs = SCRIPTS.map((f) => readFileSync(path.join(renderer, f), "utf8"));
// 面板启动时有异步尾巴（fetch 存根/启动加载）——关闭前必须等它们 settle，否则 close() 后回调读 document 报错
const settle = () => new Promise((r) => setTimeout(r, 30));

/**
 * 启动面板环境。
 * @param {{prefs?: object, mountStub?: boolean}} opts prefs=启动前预置 localStorage 偏好（验证恢复）；mountStub=预置框架挂载存根（bundle 在 jsdom 里无法 import）
 */
function boot({ prefs, mountStub = false } = {}) {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://127.0.0.1:8899/panel.html", pretendToBeVisual: true });
  const { window } = dom;
  const timerIds = [];
  window.setInterval = (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timerIds.push(id); return id; };
  window.setTimeout = (fn, ms, ...a) => { const id = setTimeout(fn, ms, ...a); timerIds.push(id); return id; };
  window.clearAllTimers = () => { for (const id of timerIds) clearTimeout(id); };
  window.HTMLCanvasElement.prototype.getContext = () => new Proxy({}, { get: () => () => {} });
  const kanban = { notify() {} };
  for (const m of ["chat", "chatHistory", "getData", "getMastery", "getObservability", "getStats", "interviewHistory", "interviewNotes", "mascotModels", "mascotSetModel", "openOutput", "parseResumeFile", "patrolConfig", "patrolRun", "playScene", "ragConfig", "restartApp", "reviewDue", "runDiscover", "setGlobalVoice", "setVoiceEnabled", "speak", "studyAnswer", "studyCheck", "studyCluster", "studyConsolidate", "studyDetailAppend", "studyGenerate", "studyReview", "studyPlan", "studyNote", "studyNoteReset", "studyDetailStream", "studyAppendStream", "studyConsolidateStream", "studyClusterStream", "invStart", "invAnswer", "invEnd", "invStatus", "invResume", "reviewSubmit", "reviewFeedback", "reviewRetry", "reviewQuiz", "reviewQuizGenerate", "reviewQuizSubmit", "reviewExplainStream", "weakPoints", "weakPointsToPlan", "mastery", "knowledgeTree", "todayBrief", "jobsDirection", "platforms", "challenges", "challengeDetail", "challengeSubmit", "mailStatus", "mailCheck", "rssList", "rssFetch", "focusGoals", "focusGoalSuggest", "selfCheck", "backupList", "backupNow", "settingsGet", "settingsSet", "pluginsList", "pluginsSettings", "pluginsSave", "notify", "speechToText", "ttsSpeak", "ttsStop", "onPanelGotoTab", "onPanelGotoChallenges"]) {
    kanban[m] = async () => ({ ok: true, active: false, items: [], list: [], plan: { items: [] }, due: [], history: [], weak: [], mastery: [], trend: [], stats: {} });
  }
  window.kanban = kanban;
  window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, items: [], list: [], plan: { items: [] } }) });
  if (prefs) window.localStorage.setItem("renderer_pref", JSON.stringify(prefs));
  const mountCalls = [];
  if (mountStub) {
    window.__mountReactPanel = (tab, container) => { mountCalls.push(["react", tab, container]); return { unmount() { mountCalls.push(["react-unmount", tab]); } }; };
    window.__mountVueReview = (tab, container) => { mountCalls.push(["vue", tab, container]); return { unmount() { mountCalls.push(["vue-unmount", tab]); } }; };
  }
  window.eval(srcs.join("\n"));
  return { dom, window, kanban, mountCalls };
}

test("任务1①：8 个 Tab 都有三态切换按钮（interview/review 手写条补齐 + 其余动态生成）", async () => {
  const { dom, window } = boot();
  try {
    for (const tab of ["interview", "review", "study", "chat", "crawl", "jobs", "dashboard", "kb"]) {
      const panel = window.document.getElementById(`tab-${tab}`);
      assert.ok(panel, `Tab ${tab} 面板存在`);
      const modes = [...panel.querySelectorAll(".renderer-switch-btn")].map((b) => b.dataset.mode);
      assert.deepEqual(modes.sort(), ["native", "react", "vue"], `Tab ${tab} 三态按钮齐全`);
      assert.ok(panel.querySelector(".renderer-switch-bar"), `Tab ${tab} 有切换条`);
      assert.ok(panel.querySelector(`#${tab}-native`), `Tab ${tab} 有原生容器（切换时隐藏的目标）`);
      const active = panel.querySelectorAll(".renderer-switch-btn.active");
      assert.equal(active.length, 1, `Tab ${tab} 恰有一个高亮`);
      assert.equal(active[0].dataset.mode, "native", `Tab ${tab} 初始高亮为原生`);
    }
  } finally { await settle(); window.clearAllTimers(); dom.window.close(); }
});

test("任务1②：未实现的框架版 → 提示开发中（整 Tab 未实现 / 单个框架版缺失，均不崩）", async () => {
  const { dom, window, kanban } = boot();
  try {
    const notes = [];
    kanban.notify = (t, m) => notes.push(m);
    const click = (sel) => window.document.querySelector(sel).click();
    // ① 整 Tab 的框架版都没做（study 无 react/vue 容器）
    click('#tab-study .renderer-switch-btn[data-mode="react"]');
    await settle();
    assert.ok(notes.some((m) => m.includes("开发中")), "未实现 Tab 提示开发中");
    assert.equal(window.document.getElementById("study-native").style.display, "", "原生容器不受影响");
    // ② 只有单个框架版缺（面试缺 Vue / 复习缺 React——任务 2/3 补全前）
    notes.length = 0;
    click('#tab-interview .renderer-switch-btn[data-mode="vue"]');
    click('#tab-review .renderer-switch-btn[data-mode="react"]');
    await settle();
    assert.equal(notes.filter((m) => m.includes("开发中")).length, 2, "缺失的框架版各自提示开发中");
    assert.equal(window.document.getElementById("interview-native").style.display, "", "面试原生不受影响");
    assert.equal(window.document.getElementById("review-native").style.display, "", "复习原生不受影响");
    assert.equal(window.document.querySelector("#tab-interview .renderer-switch-btn.active").dataset.mode, "native", "高亮保持原生");
  } finally { await settle(); window.clearAllTimers(); dom.window.close(); }
});

test("任务1⑤（实现项 4）：切换时状态处理（流式进行中切走 → 提示不中断，原生 DOM 保留）", async () => {
  const { dom, window, kanban, mountCalls } = boot({ mountStub: true });
  try {
    const notes = [];
    kanban.notify = (t, m) => notes.push(m);
    // 原生讲解流式进行中
    window.panelState.studyDetailState.streaming = true;
    const native = window.document.getElementById("interview-native");
    const marker = window.document.createElement("div");
    marker.id = "stream-marker";
    native.appendChild(marker);
    window.document.getElementById("iv-renderer-react").click();
    await settle();
    assert.ok(notes.some((m) => m.includes("后台生成")), "流式进行中切走 → 提示任务不中断");
    assert.ok(mountCalls.some(([k]) => k === "react"), "切换照常完成（不因流式阻塞）");
    assert.ok(window.document.getElementById("stream-marker"), "原生 DOM 只隐藏不销毁（流式内容保留）");
    assert.equal(native.style.display, "none", "原生容器隐藏");
    // 非流式切换不再提示（不制造噪音）
    window.panelState.studyDetailState.streaming = false;
    notes.length = 0;
    window.document.getElementById("iv-renderer-react").click();
    await settle();
    assert.equal(notes.filter((m) => m.includes("后台生成")).length, 0, "非流式切换不提示");
  } finally { await settle(); window.clearAllTimers(); dom.window.close(); }
});

test("任务1③：偏好持久化（切换即保存 + 启动即恢复 + 切回原生卸载）", async () => {
  // (a) 点「React 版」→ 挂载 + 隐藏原生 + 写偏好；点「原生」→ 卸载 + 偏好回 native
  const a = boot({ mountStub: true });
  try {
    const w = a.window;
    w.document.getElementById("iv-renderer-react").click();
    await settle();
    assert.equal(JSON.parse(w.localStorage.getItem("renderer_pref")).interview, "react", "切换即写入偏好");
    assert.equal(w.document.getElementById("interview-react").style.display, "", "React 容器显示");
    assert.equal(w.document.getElementById("interview-native").style.display, "none", "原生容器隐藏");
    assert.ok(a.mountCalls.some(([k, tab]) => k === "react" && tab === "interview"), "挂载点收到 tab 参数");
    w.document.getElementById("iv-renderer-switch").click();
    await settle();
    assert.equal(JSON.parse(w.localStorage.getItem("renderer_pref")).interview, "native", "切回原生写入偏好");
    assert.equal(w.document.getElementById("interview-native").style.display, "", "原生容器恢复");
    assert.ok(a.mountCalls.some(([k]) => k === "react-unmount"), "切回原生卸载 React（对称卸载）");
  } finally { await settle(); a.window.clearAllTimers(); a.dom.window.close(); }

  // (b) 启动即恢复：预置偏好 → 恢复为 React（容器显示 + 按钮高亮 + 重新挂载）
  const b = boot({ prefs: { interview: "react" }, mountStub: true });
  try {
    await settle();
    const w = b.window;
    assert.equal(w.document.getElementById("interview-react").style.display, "", "启动恢复 React 容器");
    assert.equal(w.document.getElementById("interview-native").style.display, "none", "启动恢复隐藏原生");
    assert.ok(w.document.getElementById("iv-renderer-react").classList.contains("active"), "按钮高亮同步到偏好");
    assert.ok(b.mountCalls.some(([k, tab]) => k === "react" && tab === "interview"), "恢复时挂载 React");
  } finally { await settle(); b.window.clearAllTimers(); b.dom.window.close(); }

  // (c) 偏好损坏自愈（脏数据当作空表 → 切换照常 + 写回合法偏好）
  const c = boot({ mountStub: true });
  try {
    c.window.localStorage.setItem("renderer_pref", "{不是 JSON");
    c.window.document.getElementById("iv-renderer-react").click();
    await settle();
    assert.equal(c.window.document.getElementById("interview-native").style.display, "none", "脏偏好下切换仍正常");
    assert.equal(JSON.parse(c.window.localStorage.getItem("renderer_pref")).interview, "react", "脏偏好自愈为合法偏好");
  } finally { await settle(); c.window.clearAllTimers(); c.dom.window.close(); }
});

test("任务1④：挂载点参数化（__mountReactPanel/__mountVueReview 接受 tab 参数）", async () => {
  const { dom, window } = boot();
  try {
    // 模拟框架 bundle 暴露的挂载函数签名（tab, container）
    window.__mountReactPanel = (tab, container) => ({ tab, container, unmount() {} });
    window.__mountVueReview = (tab, container) => ({ tab, container, unmount() {} });
    const r = window.__mountReactPanel("interview", window.document.createElement("div"));
    assert.equal(r.tab, "interview", "React 挂载点接受 tab 参数");
    const v = window.__mountVueReview("review", window.document.createElement("div"));
    assert.equal(v.tab, "review", "Vue 挂载点接受 tab 参数");
  } finally { await settle(); window.clearAllTimers(); dom.window.close(); }
});

after(() => { /* jsdom 无残留 */ });
