// 全量 TS 升级工单阶段 3：lib/jobs.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/job-collect.mjs、lib/job-match.mjs、lib/loop.mjs、plugins/job-hunter/routes/jobs.mjs、
//         lib/tools/*（惰性 import）与 tests/jobs.test.mjs
export * from "./jobs.ts";
