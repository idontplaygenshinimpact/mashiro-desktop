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

const KB_STATS = { total: 12, byKind: [{ kind: "note", n: 7 }, { kind: "mianjing", n: 5 }], enabled: true, docs: 3, followups: 2, lastBuild: "" };
const KB_SEARCH = {
  hits: [
    { kind: "followup", docId: "事件循环", section: "宏任务与微任务", content: "宏任务与微任务的执行顺序：先同步代码，再清空微任务队列，然后取下一个宏任务。" },
    { kind: "note", docId: "React Hooks", section: "闭包陷阱", content: "useEffect 依赖数组为空时会捕获首次渲染的闭包变量。" },
  ],
  stats: { docs: 3, followups: 2 },
};

function boot() {
  const dom = new JSDOM(
    '<div id="dashboard-react"></div><div id="kb-react"></div><div id="probe"></div>',
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

  kbRoot.unmount();
  // 未登记 Tab：抛错而非静默白屏（panel-core 捕获后提示"挂载失败"）
  assert.throws(() => globalThis.__mountReactPanel("study", document.getElementById("probe")), /未实现/, "未登记 Tab 抛错");
  dom.window.close();
});
