// 全量 TS 升级工单阶段 3：lib/loop.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：plugins/job-hunter/routes/misc.mjs（闭环建议/按岗面试/方向学习路由）、
//         plugins/job-hunter/routes/practice.mjs、lib/tools/*（agent 工具）与 tests/loop.test.mjs
export * from "./loop.ts";
