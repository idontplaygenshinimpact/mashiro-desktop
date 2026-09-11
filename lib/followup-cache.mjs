// 全量 TS 升级工单阶段 3：lib/followup-cache.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：plugins/job-hunter/routes/study.mjs、lib/similarity.ts、lib/knowledge-base.mjs（动态 import）、
//         tests/followup-cache.test.mjs
export * from "./followup-cache.ts";