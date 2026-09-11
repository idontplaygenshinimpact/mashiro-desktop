// 全量 TS 升级工单阶段 3：lib/widget-core.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs、lib/routes/*.mjs（readBody）、tests/widget-core.test.mjs 等
export * from "./widget-core.ts";