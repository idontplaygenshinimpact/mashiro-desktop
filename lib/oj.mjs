// 全量 TS 升级工单阶段 3：lib/oj.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/loop.mjs、lib/context-providers.ts、plugins/job-hunter/routes/oj.mjs、
//         plugins/job-hunter/routes/practice.mjs、plugins/job-hunter/server.ts 与 tests/oj.test.mjs
export * from "./oj.ts";
