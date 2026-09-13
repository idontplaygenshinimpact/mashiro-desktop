// 全量 TS 升级工单阶段 3：lib/learning-plan.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/loop.mjs、lib/review.ts、lib/today-brief.ts、widget.mjs（启动自愈）、
//         plugins/job-hunter/routes/*（学习计划路由）与 tests/learning-plan.test.mjs
export * from "./learning-plan.ts";
