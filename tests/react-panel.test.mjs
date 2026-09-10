// React 版面板护栏（渲染层可替换性验证）：
// ① main.mjs 有 React 窗口接线（同一 preload IPC 桥）；② react-panel.html 引用构建产物；
// ③ React 源码存在（jsx/markdown）；④ 业务层零改动（interview.mjs 无 React 相关侵入）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const R = (p) => path.join(ROOT, p);

test("React 面板窗口接线：main.mjs 有 createReactPanelWindow + 托盘入口（同一 preload 桥）", () => {
  const main = readFileSync(R("desktop/main.mjs"), "utf8");
  assert.ok(main.includes("createReactPanelWindow"), "窗口创建函数存在");
  assert.ok(main.includes("panel-react"), "加载独立 Vite 项目（panel-react/dist/index.html）");
  assert.ok(main.includes("React 版"), "托盘入口存在");
  assert.ok(/preload:\s*path\.join\(__dirname, "preload\.js"\)/.test(main), "复用同一 preload IPC 桥");
});

test("panel-react 独立 Vite 项目结构（package.json/vite.config/src/dist）", () => {
  assert.ok(existsSync(R("desktop/renderer/panel-react/package.json")), "子项目 package.json");
  assert.ok(existsSync(R("desktop/renderer/panel-react/vite.config.js")), "vite 配置");
  assert.ok(existsSync(R("desktop/renderer/panel-react/index.html")), "入口 html");
  for (const f of ["main.jsx", "panel.jsx", "score.jsx", "markdown.js"]) {
    assert.ok(existsSync(R("desktop/renderer/panel-react/src/" + f)), `src/${f} 存在`);
  }
  assert.ok(existsSync(R("desktop/renderer/panel-react/dist/index.html")), "构建产物 dist/index.html");
  assert.ok(existsSync(R("desktop/renderer/panel-react/dist/assets/react-panel.js")), "构建产物 react-panel.js");
});

test("React 面板只经 window.kanban IPC 桥驱动（不直连后端/不 import 业务层）", () => {
  const panel = readFileSync(R("desktop/renderer/panel-react/src/panel.jsx"), "utf8");
  // 必须使用 IPC 桥（window.kanban.invXxx）且不直连 8899/不 import lib 业务层
  for (const m of ["window.kanban.invStart", "window.kanban.invAnswer", "window.kanban.invEnd", "window.kanban.invStatus", "window.kanban.interviewHistory"]) {
    assert.ok(panel.includes(m), `使用 ${m}`);
  }
  assert.ok(!panel.includes("8899"), "不直连后端端口（解耦验证）");
  assert.ok(!panel.includes('from "../../lib/'), "不 import 业务层（解耦验证）");
});

test("业务层零改动：interview.mjs 不感知 React 渲染层", () => {
  const biz = readFileSync(R("lib/interview.mjs"), "utf8");
  assert.ok(!biz.includes("react"), "业务层无 React 相关代码");
  assert.ok(!biz.includes("window.kanban"), "业务层不引用渲染层 IPC");
});

// ---------- 前端三态并行展示工单任务 2（S1：驾驶舱/知识库） ----------

test("S1/S2 Tab 组件存在且按 tab 分发（驾驶舱/知识库/清单/爬取 + 数据入口）", () => {
  for (const f of ["tabs/Dashboard.jsx", "tabs/Kb.jsx", "tabs/Study.jsx", "tabs/Crawl.jsx", "api.js"]) {
    assert.ok(existsSync(R("desktop/renderer/panel-react/src/" + f)), `src/${f} 存在`);
  }
  const main = readFileSync(R("desktop/renderer/panel-react/src/main.jsx"), "utf8");
  assert.ok(/const TABS = \{[\s\S]*?interview:[\s\S]*?dashboard: DashboardPanel[\s\S]*?kb: KbPanel[\s\S]*?study: StudyPanel[\s\S]*?crawl: CrawlPanel/.test(main), "TABS 注册表含 interview/dashboard/kb/study/crawl");
  assert.ok(main.includes("mountReactTab"), "按 tab 挂载（未登记 Tab 抛错，不静默白屏）");
  assert.ok(/__mountReactPanel = \(tab, container\)/.test(main), "挂载点保持 (tab, container) 签名");
});

test("三态登记一致性：panel-core 的 FRAMEWORK_TABS 与 React TABS 注册表同步", () => {
  const core = readFileSync(R("desktop/renderer/panel-core.js"), "utf8");
  const main = readFileSync(R("desktop/renderer/panel-react/src/main.jsx"), "utf8");
  const declared = (core.match(/react:\s*\[([^\]]*)\]/) || [])[1];
  assert.ok(declared !== undefined, "panel-core 有 FRAMEWORK_TABS.react 登记");
  const coreTabs = declared.split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean).sort();
  const registry = (main.match(/const TABS = \{([\s\S]*?)\n\};/) || [])[1] || "";
  const reactTabs = [...registry.matchAll(/^\s*(\w+):\s*\w+Panel/gm)].map((m) => m[1]).sort();
  // 不同步 = 按钮说"有 React 版"但组件不存在（或反之：组件写了却切不过去）
  assert.deepEqual(coreTabs, reactTabs, "登记表与组件表一致（新增 Tab 必须两边同步）");
});

test("React 版 Tab 走同一数据源（HTTP 路由 / IPC 桥）+ 不 import 业务层", () => {
  const dash = readFileSync(R("desktop/renderer/panel-react/src/tabs/Dashboard.jsx"), "utf8");
  const kb = readFileSync(R("desktop/renderer/panel-react/src/tabs/Kb.jsx"), "utf8");
  const study = readFileSync(R("desktop/renderer/panel-react/src/tabs/Study.jsx"), "utf8");
  const crawl = readFileSync(R("desktop/renderer/panel-react/src/tabs/Crawl.jsx"), "utf8");
  assert.ok(dash.includes('api("/api/dashboard")'), "驾驶舱与原 panel-jobs.js 同接口 /api/dashboard");
  assert.ok(kb.includes('api("/api/knowledge/stats")') && kb.includes('api("/api/knowledge/paragraphs/search"'), "知识库与原 panel-rest.js 同接口");
  assert.ok(study.includes("window.kanban.studyPlan") && study.includes("window.kanban.studyCheck") && study.includes("window.kanban.studyGenerate"), "清单与原 panel-study.js 同 IPC 桥");
  assert.ok(crawl.includes("window.kanban.getData") && crawl.includes("window.kanban.runDiscover") && crawl.includes("window.kanban.openOutput"), "爬取与原 panel-chat.js 同 IPC 桥");
  for (const [name, src] of [["Dashboard", dash], ["Kb", kb], ["Study", study], ["Crawl", crawl]]) {
    assert.ok(!src.includes("8899"), `${name} 不硬编码端口（复用 api-client 单一来源）`);
    assert.ok(!src.includes('from "../../../lib/'), `${name} 不 import 业务层`);
  }
  // 框架特色标注（工单验收项）
  assert.ok(dash.includes("React 特性"), "驾驶舱标注 ⚛️ React 特性");
  assert.ok(kb.includes("useDeferredValue") && kb.includes("React 特性"), "知识库用 useDeferredValue 并标注");
  assert.ok(study.includes("useDeferredValue") && study.includes("React 特性"), "清单用 useDeferredValue 并标注");
  assert.ok(crawl.includes("useMemo") && crawl.includes("React 特性"), "爬取用 useMemo 派生并标注");
});