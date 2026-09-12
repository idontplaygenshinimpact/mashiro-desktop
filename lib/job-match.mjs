// 全量 TS 升级工单阶段 3：lib/job-match.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/jobs.ts / lib/job-collect.mjs / lib/loop.mjs、plugins/job-hunter/routes/jobs.mjs、
//         lib/tools/*（惰性 import）与 tests/job-match.test.mjs
export * from "./job-match.ts";
