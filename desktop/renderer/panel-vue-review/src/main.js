// Vue 复习卡入口：独立窗口挂 #app；同窗内嵌由 panel-core 调 __mountVueReview 挂指定容器
import { createApp } from "vue";
import App from "./App.vue";
import DashboardTab from "./tabs/Dashboard.vue";
import KbTab from "./tabs/Kb.vue";
import StudyTab from "./tabs/Study.vue";
import CrawlTab from "./tabs/Crawl.vue";
import JobsTab from "./tabs/Jobs.vue";

/** 挂载复习卡到指定容器（同窗内嵌用；返回 app 供对称卸载） */
export function mountReviewPanel(container) {
  const app = createApp(App);
  app.mount(container);
  return app;
}

// 独立窗口模式：有 #app（或旧嵌入 #vue-review-root）自动挂载
const autoEl = document.getElementById("vue-review-root") || document.getElementById("app");
if (autoEl) mountReviewPanel(autoEl);

// 同窗内嵌：暴露全局挂载函数（panel-core 的 switchRenderer 调用；卸载用返回的 app.unmount()）
// 前端三态并行展示工单任务 1：挂载点参数化——tab 参数（现状 review；S1→S4 推进时扩展各 Tab 组件）
// 前端三态并行展示工单任务 3：Tab 注册表（Vue 侧从只有复习扩到全 Tab）
// 登记即代表"该 Tab 有 Vue 版"——panel-core 的 FRAMEWORK_TABS.vue 决定按钮可用性，二者需同步
const TABS = { review: App, dashboard: DashboardTab, kb: KbTab, study: StudyTab, crawl: CrawlTab, jobs: JobsTab };
export function mountVueTab(tab, container) {
  const Comp = TABS[tab];
  if (!Comp) throw new Error(`Vue 版「${tab}」未实现（已登记：${Object.keys(TABS).join("/")}）`);
  const app = createApp(Comp);
  app.mount(container);
  return app;
}
globalThis.__mountVueReview = (tab, container) => (TABS[tab] && tab !== "review" ? mountVueTab(tab, container) : mountReviewPanel(container));
