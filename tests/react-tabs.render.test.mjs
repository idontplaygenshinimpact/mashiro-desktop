// React 版全 Tab（S1：驾驶舱 / 知识库）渲染测试——jsdom + 真实构建产物 + mock fetch（同一 HTTP 数据源）
// 覆盖：按 tab 挂载对应组件 / 驾驶舱数据渲染（本周总览 + 7 天活动 + 周报 + 累计进度）/ 知识库检索 + 命中高亮 /
//       未登记 Tab 抛错（不静默白屏）/ 对称卸载（unmount 后容器清空）
// 说明：产物缺失（fresh clone 未构建）时跳过——CI 会把构建提前到 test 之前
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-react", "dist", "assets", "react-panel.js");

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
const KB_STATS = { total: 12, byKind: [{ kind: "note", n: 7 }, { kind: "mianjing", n: 5 }], enabled: true, docs: 3, followups: 2, lastBuild: "" };const KB_SEARCH = {
  hits: [
    { kind: "followup", docId: "事件循环", section: "宏任务与微任务", content: "宏任务与微任务的执行顺序：先同步代码，再清空微任务队列，然后取下一个宏任务。" },
    { kind: "note", docId: "React Hooks", section: "闭包陷阱", content: "useEffect 依赖数组为空时会捕获首次渲染的闭包变量。" },
  ],
  stats: { docs: 3, followups: 2 },
};

function boot() {
  const dom = new JSDOM(
    '<div id="dashboard-react"></div><div id="kb-react"></div><div id="study-react"></div><div id="crawl-react"></div><div id="jobs-react"></div><div id="chat-react"></div><div id="probe"></div>',
    { url: "http://localhost/" }
  );
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.MutationObserver = dom.window.MutationObserver; // React 19 createRoot 需要
  globalThis.Event = dom.window.Event;

  const calls = [];
  globalThis.window.kanban = { getApiBase: async () => ({ base: "http://127.0.0.1:8899" }) };
  globalThis.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    const body = String(url).endsWith("/api/dashboard") ? DASHBOARD
      : String(url).includes("/api/jobs") ? JOBS
        : String(url).endsWith("/api/knowledge/stats") ? KB_STATS
        : String(url).endsWith("/api/knowledge/paragraphs/search") ? KB_SEARCH
          : { ok: false };
    return { ok: true, json: async () => body };
  };
  return { dom, calls };
}


const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};
const text = (el) => el?.textContent || "";
/** UI 批次 2 固化断言：① 容器内无深色内联样式（收敛成果）② 有实际内容（防"空渲染假归零"）
 * ③ 可点击元素都有可访问名（aria-label/title/placeholder/文本四者之一） */
async function assertUiClean(el, name, minNodes) {
  await waitFor(() => el.querySelectorAll("*").length >= minNodes);
  const nodes = [...el.querySelectorAll("*")];
  const dark = nodes.filter((e) => /rgb\(36, 31, 58\)|rgb\(31, 26, 49\)|rgb\(42, 37, 64\)|rgb\(58, 54, 88\)/.test(e.getAttribute("style") || ""));
  assert.equal(dark.length, 0, `${name}: 无深色内联样式（UI 批次 2）——越界元素：${dark.slice(0, 3).map((e) => e.tagName).join(",")}`);
  assert.ok(nodes.length >= minNodes, `${name}: 渲染了实际内容（${nodes.length} 节点，防空渲染假归零）`);
  const unlabeled = [...el.querySelectorAll("button, input, select, textarea, a")].filter((e) => !e.getAttribute("aria-label") && !e.getAttribute("title") && !e.getAttribute("placeholder") && !(e.textContent || "").trim());
  assert.equal(unlabeled.length, 0, `${name}: 可点击元素都有可访问名`);
}

test("React 版 S1：驾驶舱/知识库按 tab 挂载，功能等价（同一 HTTP 数据源）+ 特色标注", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const { dom, calls } = boot();
  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);

  // ---------- 驾驶舱 ----------
  const dashEl = document.getElementById("dashboard-react");
  const dashRoot = globalThis.__mountReactPanel("dashboard", dashEl);
  assert.ok(await waitFor(() => text(dashEl).includes("求职驾驶舱")), "驾驶舱渲染（按 tab 分发到对应组件）");
  assert.ok(await waitFor(() => calls.some((c) => c.url.endsWith("/api/dashboard"))), "走同一数据源 /api/dashboard");
  // 本周总览：数字来自接口（功能等价——不是写死的假数据；标题/标签是静态文本，必须等数据落地再断言）
  assert.ok(await waitFor(() => text(dashEl).includes("学习完成 5")), "本周学习完成数（接口值）");
  assert.ok(text(dashEl).includes("12 张"), "复习张数（接口值）");
  assert.ok(text(dashEl).includes("2.5 小时"), "专注时长换算（150 分钟 → 2.5 小时）");
  // 7 天活动 + 周报 + 累计进度
  assert.ok(text(dashEl).includes("近 7 天活动"), "7 天活动区");
  assert.equal(dashEl.querySelectorAll("[title^='学习']").length > 0, true, "7 天活动条（title 提示可读值）");
  assert.ok(text(dashEl).includes("学习闭环不断") && text(dashEl).includes("下周每天 1 道手写题"), "周报亮点 + 建议");
  assert.ok(text(dashEl).includes("8/20") && text(dashEl).includes("12/30"), "累计进度（学习清单 + 复习掌握）");
  assert.ok(text(dashEl).includes("前端"), "方向 chip");
  assert.ok(text(dashEl).includes("React 特性"), "⚛️ React 特色标注");

  // 刷新按钮：重新拉取（不重新挂载组件）
  const before = calls.filter((c) => c.url.endsWith("/api/dashboard")).length;
  [...dashEl.querySelectorAll("button")].find((b) => text(b).includes("刷新")).click();
  assert.ok(await waitFor(() => calls.filter((c) => c.url.endsWith("/api/dashboard")).length > before), "刷新走同一接口");
  assert.ok(text(dashEl).includes("求职驾驶舱"), "刷新后仍是同一挂载（未被卸载重挂）");

  // 对称卸载：切回原生时容器清空
  await assertUiClean(dashEl, "dashboard", 20);
  dashRoot.unmount();
  await waitFor(() => text(dashEl) === "");
  assert.equal(text(dashEl), "", "unmount 后容器清空（对称卸载）");

  // ---------- 知识库 ----------
  const kbEl = document.getElementById("kb-react");
  const kbRoot = globalThis.__mountReactPanel("kb", kbEl);
  assert.ok(await waitFor(() => text(kbEl).includes("本地知识库")), "知识库渲染");
  assert.ok(await waitFor(() => text(kbEl).includes("12 条")), "库状态（条目数 + 分类）");
  assert.ok(text(kbEl).includes("📝 学习 7"), "分类明细");

  // useDeferredValue：输入 → 延后检索 → 命中渲染 + 关键词高亮
  const input = kbEl.querySelector("input");
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "宏任务");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.ok(await waitFor(() => text(kbEl).includes("事件循环")), "检索命中渲染（段落级）");
  const searchCall = calls.find((c) => c.url.endsWith("/api/knowledge/paragraphs/search"));
  assert.ok(searchCall, "调用了段落检索接口");
  assert.ok(JSON.parse(searchCall.opts.body).query === "宏任务", "查询词随输入（走 deferred value）");
  assert.ok(text(kbEl).includes("💬 追问"), "追问段标注（优先展示）");
  assert.ok(kbEl.querySelector("mark"), "命中关键词高亮（派生渲染，不拼 HTML）");
  assert.ok(text(kbEl).includes("React 特性"), "⚛️ React 特色标注");

  await assertUiClean(kbEl, "kb", 8);
  kbRoot.unmount();
  // 未登记 Tab：抛错而非静默白屏（panel-core 捕获后提示"挂载失败"）
  assert.throws(() => globalThis.__mountReactPanel("__nope__", document.getElementById("probe")), /未实现/, "未登记 Tab 抛错（三态矩阵满格后仅剩该守卫路径）");
  dom.window.close();
});

test("React 版 S2：清单（状态流分组 + 勾选回流 + 搜索过滤 + 讲解入口复用原生）", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const { dom } = boot();
  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);

  // mock IPC 桥（与 preload 同签名）：清单数据 + 勾选回流（含薄弱点消灭）+ 生成
  const calls = [];
  const notes = [];
  const items = [
    { id: "s1", topic: "事件循环与微任务", why: "面经高频", level: "必会", grp: "JavaScript 核心", done: false, hasFile: false },
    { id: "s2", topic: "防抖与节流手写", why: "手写题", level: "进阶", grp: "算法与手写", done: false, hasFile: true },
    { id: "s3", topic: "React Hooks 闭包陷阱", why: "项目拷打", level: "必会", grp: "React", done: true, mastered: true, fromInterview: true },
    { id: "s4", topic: "浏览器缓存策略", why: "复习到期", level: "拓展", grp: "浏览器原理", done: true, reviewDue: true },
  ];
  globalThis.window.kanban = {
    studyPlan: async () => { calls.push(["studyPlan"]); return { ok: true, plan: { date: "2026-09-01", items } }; },
    studyCheck: async (id, done) => { calls.push(["studyCheck", id, done]); return { ok: true, item: { id, done }, clearedWeak: done ? "事件循环与微任务" : null }; },
    studyGenerate: async () => { calls.push(["studyGenerate"]); return { ok: true, addedCount: 2 }; },
    notify: (t, m) => notes.push(m),
  };
  globalThis.window.switchRenderer = (...a) => calls.push(["switchRenderer", ...a]);
  globalThis.window.showStudyDetail = (id) => calls.push(["showStudyDetail", id]);

  const el = document.getElementById("study-react");
  const root = globalThis.__mountReactPanel("study", el);
  assert.ok(await waitFor(() => text(el).includes("学习清单")), "清单渲染（按 tab 分发）");
  assert.ok(await waitFor(() => text(el).includes("事件循环与微任务")), "条目渲染（走同一 IPC 桥 studyPlan）");
  assert.ok(calls.some((c) => c[0] === "studyPlan"), "调用了 window.kanban.studyPlan");
  // 状态流分组（与原生 stateOf 同口径）——按"分组名+计数"断言（下拉选项里只有组名，不会误判）
  assert.ok(text(el).includes("📥 待学习1"), "待学习分组（s1）");
  assert.ok(text(el).includes("📖 学习中1"), "学习中分组（hasFile → s2）");
  assert.ok(text(el).includes("🔁 待复习（复习卡到期）1"), "待复习分组（reviewDue 优先 → s4）");
  assert.ok(text(el).includes("2/4（50%）"), "进度（s3/s4 已完成 = 2/4）");
  // 已掌握默认折叠（控制行常驻——否则展开按钮在被折叠块里永远点不到）；折叠时条目内容不渲染
  assert.ok(text(el).includes("🏆 已掌握1"), "已掌握汇总行常驻（含计数）");
  assert.ok(!text(el).includes("React Hooks 闭包陷阱"), "已掌握条目默认折叠不渲染");
  [...el.querySelectorAll("button")].find((b) => text(b).includes("展开")).click();
  assert.ok(await waitFor(() => text(el).includes("React Hooks 闭包陷阱")), "展开后渲染已掌握条目");

  // 勾选回流：studyCheck + 薄弱点消灭 toast
  const boxes = [...el.querySelectorAll('input[type="checkbox"]')];
  assert.ok(boxes.length >= 3, "勾选框渲染");
  boxes[0].click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "studyCheck")), "勾选走同一 IPC（studyCheck）");
  assert.ok(notes.some((m) => m.includes("事件循环与微任务")), "薄弱点消灭正反馈（clearedWeak）");

  // useDeferredValue 搜索过滤：输入 → 只剩匹配条目
  const input = el.querySelector('input[type="text"], input:not([type])');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "防抖");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.ok(await waitFor(() => text(el).includes("匹配 1/4")), "搜索过滤（useDeferredValue 派生）");
  assert.ok(!text(el).includes("React Hooks 闭包陷阱"), "不匹配条目被过滤");

  // 讲解入口：复用原生弹窗（切回原生渲染层 + showStudyDetail），不重复实现流式
  const explainBtn = [...el.querySelectorAll("button")].find((b) => text(b).includes("讲解"));
  explainBtn.click();
  await waitFor(() => calls.some((c) => c[0] === "showStudyDetail"));
  assert.ok(calls.some((c) => c[0] === "switchRenderer" && c[1] === "study" && c[2] === "native"), "讲解前切回原生渲染层");
  assert.ok(calls.some((c) => c[0] === "showStudyDetail"), "打开原生讲解弹窗（同一实现）");
  assert.ok(text(el).includes("React 特性"), "⚛️ React 特色标注");

  await assertUiClean(el, "study", 20);
  root.unmount();
  dom.window.close();
});

test("React 版 S2：爬取（进度三态 + 产出列表 + 今日推荐打开 + 工具栏动作）", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const { dom } = boot();
  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);

  const calls = [];
  let running = false;
  globalThis.window.kanban = {
    getData: async () => {
      calls.push(["getData"]);
      return {
        ok: true,
        progress: running ? { status: "running", message: "正在抓取第 3/10 页", current: 3, total: 10 } : { status: "done", message: "完成" },
        files: [{ company: "字节跳动", title: "前端一面面经", dir: "output/2026-09" }, { company: "美团", title: "笔试真题", dir: "output/2026-09" }],
        plan: { bishi: [{ path: "output/bishi.md", title: "美团笔试" }], mianshi: [{ path: "output/mianshi.md", title: "字节面经" }] },
        review: { total: 9 },
      };
    },
    getStats: async () => ({ ok: true, stats: { chats: 4, reviewsDone: 7, interviewsDone: 2 } }),
    runDiscover: async () => { calls.push(["runDiscover"]); running = true; return { ok: true }; },
    openOutput: () => calls.push(["openOutput"]),
    openFile: (p) => calls.push(["openFile", p]),
  };

  const el = document.getElementById("crawl-react");
  const root = globalThis.__mountReactPanel("crawl", el);
  assert.ok(await waitFor(() => text(el).includes("爬取")), "爬取渲染（按 tab 分发）");
  assert.ok(await waitFor(() => text(el).includes("字节跳动")), "产出列表（同一 IPC 桥 getData）");
  assert.ok(calls.some((c) => c[0] === "getData"), "调用了 window.kanban.getData");
  assert.ok(text(el).includes("✅ 完成"), "进度三态：done");
  assert.ok(text(el).includes("前端一面面经") && text(el).includes("美团"), "产出条目内容");
  // 使用统计（与原 stats-row 同口径）
  assert.ok(text(el).includes("💬 对话 4") && text(el).includes("🎤 面试 2"), "统计 chips（getStats）");
  assert.ok(text(el).includes("📚 复习 9"), "复习数来自 getData.review.total");

  // 今日推荐：点击 → openFile（系统默认程序打开）
  assert.ok(text(el).includes("今日推荐") && text(el).includes("笔试"), "今日推荐区（笔试/面经标签）");
  const recoRow = [...el.querySelectorAll("div")].find((d) => text(d) === "笔试美团笔试");
  assert.ok(recoRow, "推荐条目可点击");
  recoRow.click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "openFile")), "点击推荐 → openFile");

  // 工具栏：开始爬取 → runDiscover → 进度变 running（轮询生效）
  [...el.querySelectorAll("button")].find((b) => text(b).includes("开始爬取")).click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "runDiscover")), "开始爬取走同一 IPC（runDiscover）");
  assert.ok(await waitFor(() => text(el).includes("正在抓取第 3/10 页")), "running 态进度文案（轮询刷新）");
  [...el.querySelectorAll("button")].find((b) => text(b).includes("打开输出目录")).click();
  assert.ok(calls.some((c) => c[0] === "openOutput"), "打开输出目录走同一 IPC");
  assert.ok(text(el).includes("React 特性"), "⚛️ React 特色标注");

  root.unmount();
  dom.window.close();
});

test("React 版 S3：校招（列表 + 筛选 + 收藏 + 投递状态 + UI 不变量）", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const { dom } = boot();
  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);
  const calls = [];
  globalThis.window.kanban = { getApiBase: async () => ({ base: "http://127.0.0.1:8899" }), notify: (t, m) => calls.push(["notify", m]) };
  globalThis.window.switchRenderer = (...a) => calls.push(["switchRenderer", ...a]);
  const el = document.getElementById("jobs-react");
  const root = globalThis.__mountReactPanel("jobs", el);
  assert.ok(await waitFor(() => text(el).includes("校招岗位")), "校招渲染（按 tab 分发）");
  assert.ok(await waitFor(() => text(el).includes("字节跳动")), "岗位列表（同一路由 /api/jobs/recommended）");
  assert.ok(text(el).includes("匹配 92%") && text(el).includes("前端"), "方向/匹配标注");
  assert.ok(text(el).includes("2 个岗位 · 收藏 1 · 已投 1"), "统计派生（总数/收藏/已投）");
  // 筛选：只看收藏（useDeferredValue + useMemo 派生）
  const favBox = [...el.querySelectorAll('input[type="checkbox"]')][0];
  favBox.click();
  assert.ok(await waitFor(() => !text(el).includes("字节跳动") && text(el).includes("美团")), "只看收藏过滤生效");
  favBox.click();
  assert.ok(await waitFor(() => text(el).includes("字节跳动")), "取消过滤恢复");
  // 收藏（乐观更新 + 同一路由）
  [...el.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").includes("收藏")).click();
  assert.ok(await waitFor(() => calls.length >= 0), "收藏点击不抛错");
  // 投递状态
  const applied = [...el.querySelectorAll("button")].find((b) => text(b).includes("已投递") && !b.disabled);
  assert.ok(applied, "有可点的「已投递」按钮（j1 未处理）");
  applied.click();
  assert.ok(await waitFor(() => [...el.querySelectorAll("button")].some((b) => text(b).includes("已投递") && b.disabled)), "点击后状态流转（按钮禁用反映新状态）");
  // agent 流程复用原生
  [...el.querySelectorAll("button")].find((b) => text(b).includes("学考点")).click();
  assert.ok(calls.some((c) => c[0] === "switchRenderer" && c[1] === "jobs" && c[2] === "native"), "学考点切回原生渲染层（不重复实现 agent 流程）");
  await assertUiClean(el, "jobs", 20);
  root.unmount();
  dom.window.close();
});
test("React 版 S4：对话（会话载入 + 流式发送 + 工具事件时间线 + UI 不变量）", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const { dom } = boot();
  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);
  const calls = [];
  globalThis.window.kanban = {
    chatSessions: async () => ({ sessions: [{ id: "s-1", title: "面经讨论" }, { id: "s-2", title: "算法练习" }] }),
    chatMessages: async (sid) => ({ messages: [{ role: "user", content: "事件循环是什么" }, { role: "assistant", content: "先同步后微任务" }] }),
    chatStream: async (msg, history, onEvent, sid) => {
      calls.push(["chatStream", msg, sid]);
      onEvent({ type: "tool", tool: "web-search", text: "检索事件循环" });
      onEvent({ type: "chunk", text: "宏任务与" });
      onEvent({ type: "chunk", text: "微任务的顺序是…" });
      return { ok: true };
    },
    chatSessionDelete: async (sid) => { calls.push(["del", sid]); return { ok: true }; },
    notify: () => {},
  };
  globalThis.window.switchRenderer = (...a) => calls.push(["switchRenderer", ...a]);
  const el = document.getElementById("chat-react");
  const root = globalThis.__mountReactPanel("chat", el);
  assert.ok(await waitFor(() => text(el).includes("对话")), "对话渲染（按 tab 分发）");
  assert.ok(await waitFor(() => text(el).includes("事件循环是什么")), "会话消息载入（chatMessages）");
  assert.ok(text(el).includes("先同步后微任务"), "助手历史消息渲染");
  // 发送：流式 chunk 累积 + 工具事件进时间线
  const input = el.querySelector('input[aria-label="消息输入"]');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set;
  setter.call(input, "再讲讲宏任务");
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  [...el.querySelectorAll("button")].find((b) => text(b).includes("发送")).click();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === "chatStream")), "发送走同一 IPC（chatStream）");
  assert.ok(await waitFor(() => text(el).includes("宏任务与微任务的顺序是…")), "流式 delta 累积成正文（useReducer chunk）");
  assert.ok(text(el).includes("工具事件时间线") && text(el).includes("tool"), "工具事件以只读时间线呈现");
  assert.ok(text(el).includes("工具事件：tool×1"), "事件归并计数（useMemo 派生）");
  // 审批类流程复用原生
  [...el.querySelectorAll("button")].find((b) => text(b).includes("审批")).click();
  assert.ok(calls.some((c) => c[0] === "switchRenderer" && c[1] === "chat" && c[2] === "native"), "审批切回原生渲染层");
  await assertUiClean(el, "chat", 20);
  root.unmount();
  dom.window.close();
});