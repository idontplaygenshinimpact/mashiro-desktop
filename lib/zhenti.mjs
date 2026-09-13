// 全量 TS 升级工单阶段 3：lib/zhenti.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/job-collect.ts（每日门控顺带搜集）、plugins/job-hunter/routes/zhenti.mjs、
//         plugins/job-hunter/server.ts、lib/tools/*（真题工具）与 tests/zhenti.test.mjs
export * from "./zhenti.ts";
