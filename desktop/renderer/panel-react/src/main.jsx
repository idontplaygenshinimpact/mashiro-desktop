// React 版面板入口（渲染层可替换性验证）：同一 preload IPC 桥（window.kanban），只换渲染层
// 入口参数化（方案 D 同窗内嵌）：有 #root 挂 #root（独立窗口）；panel-core 调 __mountReactPanel 挂指定容器
import { createRoot } from "react-dom/client";
import { InterviewPanel } from "./panel.jsx";
import { DashboardPanel } from "./tabs/Dashboard.jsx";
import { KbPanel } from "./tabs/Kb.jsx";
import { StudyPanel } from "./tabs/Study.jsx";
import { CrawlPanel } from "./tabs/Crawl.jsx";
import { JobsPanel } from "./tabs/Jobs.jsx";
import { ChatPanel } from "./tabs/Chat.jsx";

// 开发模式（vite dev，浏览器打开）：window.kanban 由 Electron preload 注入；
// 浏览器无 preload → 注入 dev mock（仅 DEV 生效，生产构建不含）
if (!globalThis.window.kanban && import.meta.env.DEV) {
  const mock = {
    invStart: async (cfg) => ({ ok: true, round: 1, roundType: "开场", question: `（dev mock）目标岗位：${cfg.position || "前端"}。先自我介绍并讲一个项目。`, dimension: "表达清晰", basis: "考察表达组织", criteria: "结构完整有量化", boundary: "不背稿", depth: 0, totalRounds: 6 }),
    invAnswer: async () => ({ round: 1, roundType: "开场", question: "（dev mock）下一问：说说项目难点。", dimension: "技术深度", scores: { tech: 80, expr: 90, depth: 70, edge: 60, reflect: 75 }, total: 75, finished: false }),
    invEnd: async () => ({ ok: true, report: "## 复盘（dev mock）\n\n**亮点**：表达清晰\n- 技术基础扎实", hint: "dev mock" }),
    invStatus: async () => ({ ok: true, active: false }),
    interviewHistory: async () => ({ history: [] }),
  };
  globalThis.window.kanban = mock;
  console.log("[react-panel] dev mock IPC 桥已注入（浏览器开发模式）");
}

/** 挂载面试面板到指定容器（同窗内嵌用；返回 root 供对称卸载）
 * 前端三态并行展示工单任务 1：挂载点参数化——tab 参数决定渲染哪个 Tab 组件 */
export function mountInterviewPanel(container) {
  const root = createRoot(container);
  root.render(<InterviewPanel />);
  return root;
}

// 前端三态并行展示工单任务 2：Tab 注册表（S1 驾驶舱/知识库 → S2 清单 → S3 校招 → S4 对话）
// 登记即代表"该 Tab 有 React 版"——panel-core 的 FRAMEWORK_TABS 决定按钮可用性，二者需同步
const TABS = {
  interview: InterviewPanel,
  dashboard: DashboardPanel,
  kb: KbPanel,
  study: StudyPanel,
  crawl: CrawlPanel,
  jobs: JobsPanel,
  chat: ChatPanel,
};

/** 按 Tab 挂载 React 版（未登记的 Tab 直接抛错——由 panel-core 捕获并提示，不静默白屏） */
export function mountReactTab(tab, container) {
  const Comp = TABS[tab];
  if (!Comp) throw new Error(`React 版「${tab}」未实现（已登记：${Object.keys(TABS).join("/")}）`);
  const root = createRoot(container);
  root.render(<Comp />);
  return root;
}

// 独立窗口模式：有 #root 自动挂载（vite dev 的 index.html 容器 → 面试面板）
const autoEl = document.getElementById("root");
if (autoEl) mountInterviewPanel(autoEl);

// 同窗内嵌：暴露全局挂载函数（panel-core 的 switchRenderer 调用；卸载用返回的 root.unmount()）
globalThis.__mountReactPanel = (tab, container) => mountReactTab(tab, container);
