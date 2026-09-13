// 全量 TS 升级工单阶段 3：lib/contracts/study.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/routes/*（服务端校验）、plugins/*/routes/*（#lib/contracts 子路径导入）、
//         desktop preload 的 kanban-api.d.ts（import type）与 tests/contracts.test.mjs
export * from "./study.ts";