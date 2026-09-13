// 全量 TS 升级工单阶段 3：lib/ai-career.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/loop.mjs、lib/tools/exec-tools.ts、plugins/job-hunter/routes/practice.mjs、
//         scripts/import-ai-career.mjs、scripts/import-codetop-top400.mjs 与 tests/ai-career.test.mjs
export * from "./ai-career.ts";
