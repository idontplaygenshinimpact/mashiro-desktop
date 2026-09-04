// plugins/job-hunter/server.mjs —— 秋招助手插件入口
// 协议：导出 register(api)，api = { router, db, getCorsOrigin, laneSubmit, ... }
// 聚合 12 个业务路由域（面试/清单/复习/题库/真题/校招/邮件/知识库/专注/爬取产出/通知），
// 业务域共享 lib/ 底层模块（单一数据源，闭环依赖不拆散）
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

export const meta = { id: "job-hunter", name: "秋招助手", version: "0.1.0" };

export function register(api) {
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
