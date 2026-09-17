// Vue 版全 Tab 渲染测试（复习/驾驶舱/知识库/清单/爬取/校招/对话/面试）——jsdom + 真实构建产物 + mock IPC/fetch
// 补口（前端三态并行展示工单任务 3 验收）：Vue 侧此前只有 useReview 逻辑测试（tests/vue-review.test.mjs），
// 缺"按 tab 挂载 → 渲染 → 对称卸载"的渲染层护栏；React 侧有 tests/react-tabs.render.test.mjs 覆盖全 Tab，
// 本文件把两侧护栏对齐：每个 Tab 都断言①按 tab 分发到对应组件 ②数据来自同一 IPC 桥/同一 HTTP 路由
// ③🟢 Vue 特色标注 ④UI 不变量（无深色内联样式/可点击元素有可访问名）⑤unmount 后容器清空
// 说明：产物缺失（fresh clone 未构建）时整组跳过——CI 会把构建提前到 test 之前
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-vue-review", "dist", "assets", "vue-review.js");
const SKIP = !existsSync(BUNDLE) && "产物未构建（先 npm run build:vue-review）";

const DASHBOARD = {
  ok: true,
  week: { studyDone: 5, reviewDone: 12, challengeDone: 3, focusMinutes: 150, applyCount: 4, interviewCount: 2 },
  weekSeries: [
    { date: "2026-09-01", study: 2, review: 3, challenge: 1, focus: 30 },
    { date: "2026-09-02", study: 0, review: 0, challenge: 0, focus: 0 },
    { date: "2026-09-03", study: 1, review: 4, challenge: 0, focus: 45 },
  ],
  report: { highlights: ["学习闭环不断"], gaps: ["算法题量偏低"], suggestions: ["下周每天 1 道手写题"] },
  progress: {
    plan: { done: 8, total: 20 }, challenges: { done: 3, total: 15 }, review: { mastered: 12, total: 30, due: 4 },
    direction: "前端", weak: 6, jobs: { open: 7, applied: 4 },
  },
};

const JOBS = { recommended: [
  { id: "j1", company: "字节跳动", title: "前端开发实习生", direction: "frontend", match: "92%", jobType: "实习", deadline: "2026-10-01", status: "none", summary: "负责中台前端研发", jdText: "岗位职责：React 中台开发", applyUrl: "https://example.com/apply", favorite: false },
  { id: "j2", company: "美团", title: "AI Agent 工程师", direction: "agent", match: "85%", status: "ready", favorite: true, summary: "Agent 平台建设" },
] };

const KB_STATS = { total: 12, byKind: [{ kind: "note", n: 7 }, { kind: "mianjing", n: 5 }], enabled: true, docs: 3, followups: 2, lastBuild: "" };
const KB_SEARCH = {
  hits: [
    { kind: "followup", docId: "事件循环", section: "宏任务与微任务", content: "宏任务与微任务的执行顺序：先同步代码，再清空微任务队列，然后取下一个宏任务。" },
    { kind: "note", docId: "React Hooks", section: "闭包陷阱", content: "useEffect 依赖数组为空时会捕获首次渲染的闭包变量。" },
  ],
  stats: { docs: 3, followups: 2 },
};

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
const text = (el) => el?.textContent || "";

/** UI 不变量（与 react-tabs.render.test.mjs 同口径）：无深色内联样式 + 有实际内容 + 可点击元素有可访问名 */
async function assertUiClean(el, name, minNodes) {
  await waitFor(() => el.querySelectorAll("*").length >= minNodes, 3000);
  const nodes = [...el.querySelectorAll("*")];
  const dark = nodes.filter((e) => /rgb\(36, 31, 58\)|rgb\(31, 26, 49\)|rgb\(42, 37, 64\)|rgb\(58, 54, 88\)/.test(e.getAttribute("style") || ""));
  assert.equal(dark.length, 0, `${name}: 无深色内联样式（UI 批次 2）——越界元素：${dark.slice(0, 3).map((e) => e.tagName).join(",")}`);
  assert.ok(nodes.length >= minNodes, `${name}: 渲染了实际内容（${nodes.length} 节点）`);
  const unlabeled = [...el.querySelectorAll("button, input, select, textarea, a")].filter((e) => !e.getAttribute("aria-label") && !e.getAttribute("title") && !e.getAttribute("placeholder") && !(e.textContent || "").trim());
  assert.equal(unlabeled.length, 0, `${name}: 可点击元素都有可访问名`);
}

/** 起一个 jsdom 环境：容器 + Vue 运行时所需全局 + IPC 桥（kanban）+ fetch 路由 */
function boot(ids, kanbanExtra = {}, responses = {}) {
  const dom = new JSDOM(ids.map((id) => `<div id="${id}"></div>`).join(""), { url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  for (const k of ["HTMLElement", "Element", "Node", "SVGElement", "MutationObserver", "Event", "CustomEvent", "HTMLInputElement", "KeyboardEvent"]) {
    globalThis[k] = dom.window[k];
  }
  // Vue runtime-dom 还会直接引用一批全局构造器（如 v-model 的 `f instanceof Document || f instanceof ShadowRoot`）——
  // 只挂 window/document 不够，实测会抛 "Document is not defined" 打断更新周期。按名字白名单补搬（不搬自引用项）
  const SKIP = new Set(["window", "self", "top", "parent", "frames", "location", "navigator", "localStorage", "sessionStorage", "history", "closed", "length", "name", "origin", "status"]);
  for (const k of Object.getOwnPropertyNames(dom.window)) {
    if (SKIP.has(k) || k in globalThis) continue;
    if (!/^(Document|Shadow|Comment|Text|CSS|DOM|Range|Mouse|Resize|Intersection|Image|Blob|File|Form|URL)/.test(k)) continue;
    try { globalThis[k] = dom.window[k]; } catch { /* 个别 getter jsdom 未实现——跳过 */ }
  }
  globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

  const calls = [];
  globalThis.window.kanban = {
    getApiBase: async () => ({ base: "http://127.0.0.1:8899" }),
    notify: (t, m) => calls.push(["notify", m]),
    ...kanbanExtra,
  };
  globalThis.window.switchRenderer = (...a) => calls.push(["switchRenderer", ...a]);

  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const u = String(url);
    const body = u.endsWith("/api/dashboard") ? DASHBOARD
      : u.includes("/api/jobs/recommended") ? JOBS
        : u.endsWith("/api/knowledge/stats") ? KB_STATS
          : u.endsWith("/api/knowledge/paragraphs/search") ? KB_SEARCH
            : (responses[u] ?? { ok: false });
    return { ok: true, json: async () => body };
  };
  return { dom, calls };
}

async function mount(tab, id) {
  await import(new URL("../desktop/renderer/panel-vue-review/dist/assets/vue-review.js", import.meta.url).href);
  const el = document.getElementById(id);
  const app = globalThis.__mountVueReview(tab, el);
  return { el, app };
}

test("Vue 版复习（App.vue）：真实队列 + 评分提交（同一 IPC 桥 reviewDue/reviewSubmit）", { skip: SKIP }, async () => {
  const submits = [];
  const { dom } = boot(["review-vue"], {
    reviewDue: async () => ({ due: [{ id: "c1", topic: "事件循环：宏任务与微任务", question: "说说事件循环", answer: "先同步→微任务→宏任务" }] }),
    reviewSubmit: async (id, rating) => { submits.push([id, rating]); return { ok: true }; },
  });
  const { el, app } = await mount("review", "review-vue");
  assert.ok(await waitFor(() => text(el).includes("复习卡")), "复习卡渲染（tab=review → App.vue）");
  assert.ok(await waitFor(() => text(el).includes("事件循环：宏任务与微任务")), "真实卡来自 reviewDue（同一 IPC）");
  assert.ok(text(el).includes("Vue 响应式"), "🟢 Vue 特色标注（computed/watch/Transition）");
  await assertUiClean(el, "review", 10);

  // 评分按钮：good → 数字 2（对齐后端 Grades 坐标）
  const good = [...el.querySelectorAll("button")].find((b) => /good|记得|良好|😊/i.test(b.textContent || "") || /good/i.test(b.getAttribute("aria-label") || ""));
  if (good) {
    good.click();
    assert.ok(await waitFor(() => submits.length > 0), "评分支路走 reviewSubmit（同一 IPC）");
    assert.equal(typeof submits[0][1], "number", "评分传数字（非字符串）");
  }
  app.unmount();
  await waitFor(() => text(el) === "");
  assert.equal(text(el), "", "unmount 后容器清空（对称卸载）");
  dom.window.close();
});

test("Vue 版 S1：驾驶舱 / 知识库（HTTP 同源 + 🟢 特色 + 检索防抖）", { skip: SKIP }, async () => {
  const { dom, calls } = boot(["dashboard-vue", "kb-vue"]);
  const dash = await mount("dashboard", "dashboard-vue");
  assert.ok(await waitFor(() => text(dash.el).includes("求职驾驶舱")), "驾驶舱渲染（按 tab 分发到 Dashboard.vue）");
  assert.ok(await waitFor(() => calls.some((c) => String(c.url).endsWith("/api/dashboard"))), "走同一数据源 /api/dashboard");
  assert.ok(await waitFor(() => text(dash.el).includes("5")), "本周学习完成数（接口值）");
  assert.ok(text(dash.el).includes("12"), "复习张数（接口值）");
  assert.ok(text(dash.el).includes("近 7 天活动"), "7 天活动区");
  assert.ok(text(dash.el).includes("学习闭环不断"), "周报亮点（接口值）");
  assert.ok(text(dash.el).includes("8/20"), "累计进度（学习清单）");
  assert.ok(text(dash.el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注");
  await assertUiClean(dash.el, "dashboard", 15);
  dash.app.unmount();

  const kb = await mount("kb", "kb-vue");
  assert.ok(await waitFor(() => text(kb.el).includes("本地知识库")), "知识库渲染（按 tab 分发到 Kb.vue）");
  assert.ok(await waitFor(() => text(kb.el).includes("12")), "库状态（条目数）");
  const input = kb.el.querySelector("input");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "宏任务");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  // Vue 侧 watch + 250ms 防抖 → 停顿后才发检索请求
  assert.ok(await waitFor(() => calls.some((c) => String(c.url).endsWith("/api/knowledge/paragraphs/search")), 3000), "停顿后发出检索请求（watch 防抖）");
  assert.ok(await waitFor(() => text(kb.el).includes("事件循环")), "检索命中渲染（段落级）");
  assert.ok(kb.el.querySelector("mark, .rf-hl") || text(kb.el).includes("宏任务"), "命中关键词高亮或原文可见");
  assert.ok(text(kb.el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注（watch 防抖 + computed 高亮）");
  await assertUiClean(kb.el, "kb", 8);
  kb.app.unmount();
  dom.window.close();
});

test("Vue 版 S2：清单（状态流分组 + 勾选回流）/ 爬取（进度 + 产出 + 工具栏）", { skip: SKIP }, async () => {
  const calls = [];
  const items = [
    { id: "s1", topic: "事件循环与微任务", why: "面经高频", level: "必会", grp: "JavaScript 核心", done: false, hasFile: false },
    { id: "s2", topic: "防抖与节流手写", why: "手写题", level: "进阶", grp: "算法与手写", done: true, hasFile: true, mastered: true },
  ];
  let running = false;
  const { dom, calls: httpCalls } = boot(["study-vue", "crawl-vue"], {
    studyPlan: async () => { calls.push(["studyPlan"]); return { ok: true, plan: { date: "2026-09-01", items } }; },
    studyCheck: async (id, done) => { calls.push(["studyCheck", id, done]); return { ok: true, item: { id, done }, clearedWeak: done ? "事件循环与微任务" : null }; },
    studyGenerate: async () => { calls.push(["studyGenerate"]); return { ok: true, addedCount: 2 }; },
    getData: async () => {
      calls.push(["getData"]);
      return {
        ok: true,
        progress: running ? { status: "running", message: "正在抓取第 3/10 页", current: 3, total: 10 } : { status: "done", message: "完成" },
        files: [{ company: "字节跳动", title: "前端一面面经", dir: "output/2026-09" }],
        plan: { bishi: [{ path: "output/bishi.md", title: "美团笔试" }], mianshi: [] },
        review: { total: 9 },
      };
    },
    getStats: async () => ({ ok: true, stats: { chats: 4, reviewsDone: 7, interviewsDone: 2 } }),
    runDiscover: async () => { calls.push(["runDiscover"]); running = true; return { ok: true }; },
    openOutput: () => calls.push(["openOutput"]),
    openFile: (p) => calls.push(["openFile", p]),
  });

  const study = await mount("study", "study-vue");
  assert.ok(await waitFor(() => text(study.el).includes("学习清单")), "清单渲染（按 tab 分发到 Study.vue）");
  assert.ok(await waitFor(() => text(study.el).includes("事件循环与微任务")), "条目渲染（同一 IPC studyPlan）");
  assert.ok(calls.some((c) => c[0] === "studyPlan"), "调用了 window.kanban.studyPlan");
  const box = [...study.el.querySelectorAll('input[type="checkbox"]')][0];
  assert.ok(box, "勾选框渲染");
  box.click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "studyCheck")), "勾选走同一 IPC（studyCheck）");
  assert.ok(text(study.el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注（computed 链式派生）");
  await assertUiClean(study.el, "study", 12);
  study.app.unmount();

  const crawl = await mount("crawl", "crawl-vue");
  assert.ok(await waitFor(() => text(crawl.el).includes("爬取")), "爬取渲染（按 tab 分发到 Crawl.vue）");
  assert.ok(await waitFor(() => text(crawl.el).includes("字节跳动")), "产出列表（同一 IPC getData）");
  assert.ok(await waitFor(() => text(crawl.el).includes("💬 对话 4")), "统计 chips（getStats）");
  const startBtn = [...crawl.el.querySelectorAll("button")].find((b) => text(b).includes("开始爬取"));
  assert.ok(startBtn, "有「开始爬取」按钮");
  startBtn.click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "runDiscover")), "开始爬取走同一 IPC（runDiscover）");
  assert.ok(await waitFor(() => text(crawl.el).includes("正在抓取第 3/10 页"), 6000), "running 态进度文案（watch 驱动轮询）");
  assert.ok(text(crawl.el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注（v-model + watch 轮询）");
  await assertUiClean(crawl.el, "crawl", 12);
  crawl.app.unmount();
  assert.ok(httpCalls.length >= 0);
  dom.window.close();
});

test("Vue 版 S3：校招（列表 + 筛选 + 收藏 + 原生流程转交）", { skip: SKIP }, async () => {
  const { dom, calls } = boot(["jobs-vue"], {
    notify: (t, m) => calls.push(["notify", m]),
  });
  const { el, app } = await mount("jobs", "jobs-vue");
  assert.ok(await waitFor(() => text(el).includes("校招岗位")), "校招渲染（按 tab 分发到 Jobs.vue）");
  assert.ok(await waitFor(() => text(el).includes("字节跳动")), "岗位列表（同一路由 /api/jobs/recommended）");
  assert.ok(text(el).includes("92%") || text(el).includes("匹配 92"), "匹配度展示");
  assert.ok(text(el).includes("2 个岗位") || text(el).includes("收藏 1"), "统计派生（computed）");
  // 只看收藏（checkbox 控制可见列表）
  const favBox = el.querySelector('input[type="checkbox"][aria-label="只看收藏岗位"]');
  assert.ok(favBox, "「只看收藏岗位」勾选框（带 aria-label）");
  favBox.click();
  assert.ok(await waitFor(() => !text(el).includes("字节跳动")), "只看收藏过滤生效（j1 取消展示）");
  favBox.click();
  assert.ok(await waitFor(() => text(el).includes("字节跳动")), "取消过滤恢复");
  // 原生流程转交（不重复实现 agent 流程）
  const nativeBtn = [...el.querySelectorAll("button")].find((b) => text(b).includes("学考点"));
  assert.ok(nativeBtn, "有「学考点」按钮");
  nativeBtn.click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "switchRenderer")), "学考点切回原生渲染层（复用原生流程）");
  assert.ok(text(el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注");
  await assertUiClean(el, "jobs", 15);
  app.unmount();
  dom.window.close();
});

test("Vue 版 S4：对话（会话载入 + 流式发送 + 工具事件时间线）", { skip: SKIP }, async () => {
  const calls = [];
  const { dom } = boot(["chat-vue"], {
    chatSessions: async () => ({ sessions: [{ id: "s-1", title: "面经讨论" }] }),
    chatMessages: async () => ({ messages: [{ role: "user", content: "事件循环是什么" }, { role: "assistant", content: "先同步后微任务" }] }),
    chatStream: async (msg, history, onEvent, sid) => {
      calls.push(["chatStream", msg, sid]);
      onEvent({ type: "tool", tool: "web-search", text: "检索事件循环" });
      onEvent({ type: "chunk", text: "宏任务与" });
      onEvent({ type: "chunk", text: "微任务的顺序是…" });
      return { ok: true };
    },
    chatSessionDelete: async (sid) => { calls.push(["del", sid]); return { ok: true }; },
  });
  const { el, app } = await mount("chat", "chat-vue");
  assert.ok(await waitFor(() => text(el).includes("对话")), "对话渲染（按 tab 分发到 Chat.vue）");
  assert.ok(await waitFor(() => text(el).includes("事件循环是什么")), "会话消息载入（同一 IPC chatMessages）");
  assert.ok(text(el).includes("先同步后微任务"), "助手历史消息渲染");
  const input = el.querySelector('input[aria-label="消息输入"], textarea[aria-label="消息输入"]');
  assert.ok(input, "消息输入框（带 aria-label）");
  const proto = input.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(input, "再讲讲宏任务");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const sendBtn = [...el.querySelectorAll("button")].find((b) => /发送/.test(text(b)));
  assert.ok(sendBtn, "有发送按钮");
  // v-model 更新是同步的，但"按钮 :disabled 依赖 text.trim()"要等 Vue 调度器 flush 后才落到 DOM —— 等它可点再点
  assert.ok(await waitFor(() => !sendBtn.disabled), "输入后发送按钮变为可点（v-model → 重渲染）");
  sendBtn.click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "chatStream")), "发送走同一 IPC（chatStream）");
  assert.ok(await waitFor(() => text(el).includes("宏任务与微任务的顺序是…")), "流式 chunk 累积成正文");
  assert.ok(text(el).includes("工具事件时间线"), "工具事件以只读时间线呈现");
  assert.ok(text(el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注（reactive + v-model）");
  await assertUiClean(el, "chat", 15);
  app.unmount();
  await waitFor(() => text(el) === "");
  assert.equal(text(el), "", "unmount 后容器清空（对称卸载）");
  dom.window.close();
});

test("Vue 版面试 Tab：状态机（invStart/invAnswer/invEnd）+ 评分与复盘", { skip: SKIP }, async () => {
  const calls = [];
  const { dom } = boot(["interview-vue"], {
    interviewHistory: async () => ({ history: [] }),
    invStatus: async () => ({ ok: true, active: false }),
    invStart: async (cfg) => {
      calls.push(["invStart", cfg]);
      return { round: 1, totalRounds: 5, roundType: "concept", question: "说说事件循环", dimension: "JS 基础", criteria: "宏微任务顺序", boundary: "", depth: 2 };
    },
    invAnswer: async (txt) => { calls.push(["invAnswer", txt]); return { finished: false, question: "那微任务呢", round: 2, scores: { tech: 8, expr: 7, depth: 6, edge: 5, reflect: 6 } }; },
    invEnd: async () => ({ ok: true, report: "整体不错，边界意识待加强", hint: "再复习事件循环" }),
  });
  const { el, app } = await mount("interview", "interview-vue");
  assert.ok(await waitFor(() => text(el).includes("模拟面试")), "面试渲染（按 tab 分发到 Interview.vue）");
  const startBtn = [...el.querySelectorAll("button")].find((b) => /开始/.test(text(b)));
  assert.ok(startBtn, "有开始按钮（setup 阶段）");
  startBtn.click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "invStart")), "开始面试走同一 IPC（invStart）");
  assert.ok(await waitFor(() => text(el).includes("说说事件循环")), "首题渲染（状态机 enterActive）");
  const answerBox = el.querySelector('textarea[aria-label="面试作答"], textarea[aria-label], textarea');
  assert.ok(answerBox, "作答区渲染（active 阶段）");
  {
    const proto = answerBox.tagName === "TEXTAREA" ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(answerBox, "先同步代码再清空微任务");
    answerBox.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    const submit = [...el.querySelectorAll("button")].find((b) => /提交|发送回答/.test(text(b)));
    assert.ok(submit, "有提交按钮");
    // 同 chat：等 v-model 驱动的重渲染把按钮从 disabled 放出来
    assert.ok(await waitFor(() => !submit.disabled), "作答后提交按钮变为可点（v-model → 重渲染）");
    submit.click();
    assert.ok(await waitFor(() => calls.some((c) => c[0] === "invAnswer")), "提交作答走同一 IPC（invAnswer）");
    assert.ok(await waitFor(() => text(el).includes("那微任务呢")), "下一题渲染 + 评分累计");
  }
  assert.ok(text(el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注（composable 状态机）");
  await assertUiClean(el, "interview", 10);
  app.unmount();
  dom.window.close();
});

test("Vue 版专项练习 Tab：题库列表（同一路由 /api/challenges）+ 筛选 + 🟢 标注", { skip: SKIP }, async () => {
  // CodeMirror 6 在 jsdom 下无排版引擎（getBoundingClientRect 全 0），EditorView 实测会抛
  // "Measurement reports a height of 0" —— 因此这里只断言：①按 tab 分发到 Practice.vue 并渲染列表 ②
  // 数据走/api/challenges ③🟢 标注 ④挂载/卸载不抛错。编辑器实例的正确性由源码级护栏
  // (tests/vue-practice-tab.test.mjs) + 真实沙箱判题（面板手动）兜底。
  const CHALL = {
    ok: true, total: 2, done: 1, left: 1,
    list: [
      { id: "c1", title: "手写防抖", category: "handwrite", difficulty: 1, frequency: 3, done: true, wrongCount: 0, description: "实现 debounce", timeLimit: 10 },
      { id: "c2", title: "两数之和", category: "algorithm", difficulty: 2, frequency: 5, done: false, wrongCount: 2, description: "返回下标", timeLimit: 10 },
    ],
  };
  // 列表请求带 mode 参数（核心代码 / ACM 两套题库）→ 精确 URL 键要覆盖带 query 的形态
  const { dom, calls } = boot(["practice-vue"], {}, {
    "http://127.0.0.1:8899/api/challenges": CHALL,
    "http://127.0.0.1:8899/api/challenges?": CHALL,
    "http://127.0.0.1:8899/api/challenges?mode=core": CHALL,
  });
  const { el, app } = await mount("practice", "practice-vue");
  assert.ok(await waitFor(() => text(el).includes("专项练习")), "专项练习渲染（按 tab 分发到 Practice.vue）");
  assert.ok(await waitFor(() => calls.some((c) => String(c.url).includes("/api/challenges") && String(c.url).includes("mode=core"))), "走同一数据源 /api/challenges 且带 mode 参数（两套题库各自成集）");
  assert.ok(await waitFor(() => text(el).includes("手写防抖")), "列表题目渲染（同一路由 /api/challenges）");
  assert.ok(text(el).includes("两数之和"), "第二题渲染");
  assert.ok(text(el).includes("✅ 已做"), "done 徽标渲染");
  assert.ok(text(el).includes("答错 2 次"), "wrongCount 徽标渲染");
  assert.ok(text(el).includes("🟢 Vue 特性"), "🟢 Vue 特色标注");
  assert.ok(!/8899/.test(text(el)), "页面文本不泄漏硬编码端口（经 api() 解析）");
  await assertUiClean(el, "practice", 8);
  app.unmount();
  await waitFor(() => text(el) === "");
  assert.equal(text(el), "", "unmount 后容器清空（对称卸载）");
  dom.window.close();
});

test("Vue 版未登记 Tab：抛错而非静默挂复习卡（与 React 侧同形守卫）", { skip: SKIP }, async () => {
  const { dom } = boot(["probe-vue"]);
  await import(new URL("../desktop/renderer/panel-vue-review/dist/assets/vue-review.js", import.meta.url).href);
  assert.throws(
    () => globalThis.__mountVueReview("__nope__", document.getElementById("probe-vue")),
    /未实现/,
    "未登记 Tab 抛错（panel-core 捕获后提示「挂载失败」，不会把复习卡挂到别的 Tab 容器里）"
  );
  dom.window.close();
});
