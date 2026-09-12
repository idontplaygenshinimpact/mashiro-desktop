// 全量 TS 升级工单阶段 3：lib/quiz.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：plugins/job-hunter/routes/review.mjs、lib/review.ts、tests/quiz.test.mjs
export * from "./quiz.ts";
