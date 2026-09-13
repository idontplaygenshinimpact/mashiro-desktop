// 全量 TS 升级工单阶段 3：lib/knowledge-base.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：plugins/job-hunter/routes/kb.mjs、lib/rag.ts（段落检索）、scripts/kb-eval.mjs 与 tests/knowledge-base.test.mjs
export * from "./knowledge-base.ts";
