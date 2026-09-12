// 全量 TS 升级工单阶段 3：lib/job-collect.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/jobs.mjs（re-export 桶策略）、plugins/job-hunter/routes/jobs.mjs、
//         lib/loop.mjs、widget.mjs（每日门控）与 tests/job-collect.test.mjs
export * from "./job-collect.ts";
