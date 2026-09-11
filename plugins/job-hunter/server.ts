// plugins/job-hunter/server.ts —— 秋招助手插件入口
// 协议：导出 register(api)，api = { router, db, getCorsOrigin, laneSubmit, ... }
// 聚合 12 个业务路由域（面试/清单/复习/题库/真题/校招/邮件/知识库/专注/爬取产出/通知），
// 业务域共享 lib/ 底层模块（单一数据源，闭环依赖不拆散）
// 全量 TS 升级工单阶段 4（插件）：plugins/job-hunter/server.mjs → .ts
//   插件入口是**按路径约定**加载的（manifest/加载器指向 server.mjs），测试也直接 import 该路径 →
//   保留同名 .mjs 一行桶：协议入口不变、加载器与 tests/routes-registry.test.mjs 零改动
import { registerReviewRoutes } from "./routes/review.mjs";
import { registerKbRoutes } from "./routes/kb.mjs";
import { registerPracticeRoutes } from "./routes/practice.mjs";
import { registerMiscRoutes } from "./routes/misc.mjs";
import { registerStudyRoutes } from "./routes/study.mjs";
import { registerInterviewRoutes } from "./routes/interview.mjs";
import { registerJobsRoutes } from "./routes/jobs.mjs";
import { registerZhentiRoutes } from "./routes/zhenti.mjs";
import { registerOjRoutes } from "./routes/oj.mjs";
import { registerFocusRoutes } from "./routes/focus.mjs";
import { registerMailRoutes } from "./routes/mail.mjs";
import { registerRssRoutes } from "./routes/rss.mjs";

/** 插件元信息（manifest 同源：id/name/version） */
export interface PluginMeta {
  id: string;
  name: string;
  version: string;
}

/**
 * 宿主注入的 API 面（协议约定）。
 * 用**最小必要形状**声明（router 只需能传给各路由域注册函数；业务域 .mjs 未类型化 → 传参天然宽松），
 * 避免在插件入口重复声明宿主内部类型。
 */
export interface PluginApi {
  router: unknown;
  db?: unknown;
  /** 宿主注入的回调：插件入口不需要知道宿主内部精确签名（各路由域由 JSDoc 各自推断），
   *  用 rest-args 松散签名表达"任意宿主回调"，避免在协议入口重复声明宿主形状 */
  getCorsOrigin?: (...args: any[]) => any;
  laneSubmit?: (...args: any[]) => any;
}

export const meta: PluginMeta = { id: "job-hunter", name: "秋招助手", version: "0.1.0" };

export function register(api: PluginApi): { ok: boolean } {
  const { router, getCorsOrigin, laneSubmit } = api;
  registerReviewRoutes(router, { getCorsOrigin });
  registerKbRoutes(router);
  registerPracticeRoutes(router);
  registerMiscRoutes(router);
  registerStudyRoutes(router, { getCorsOrigin, laneSubmit });
  registerInterviewRoutes(router, { laneSubmit });
  registerJobsRoutes(router);
  registerZhentiRoutes(router);
  registerOjRoutes(router, { getCorsOrigin });
  registerFocusRoutes(router);
  registerMailRoutes(router);
  registerRssRoutes(router);
  return { ok: true };
}
