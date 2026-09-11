// 全量 TS 升级工单阶段 3：lib/web-search.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/tools/exec-tools.ts、lib/ai.ts（动态 import）、tests/web-search.test.mjs、
//         tests/agent.test.mjs + tests/helpers.mjs（mock.module 绑定此 URL——桶名必须保持 .mjs，否则 mock 静默失效）
export * from "./web-search.ts";