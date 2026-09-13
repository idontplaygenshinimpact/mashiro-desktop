// 全量 TS 升级工单阶段 3：lib/rss.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（每日摘要调度）、lib/loop.mjs、plugins/job-hunter/routes/rss.mjs、
//         plugins/job-hunter/server.ts 与 tests/rss.test.mjs
export * from "./rss.ts";
