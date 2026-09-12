// 全量 TS 升级工单阶段 3：lib/plugin-admin.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs、tests/plugin-admin.test.mjs（按 .mjs 路径动态 import）
export * from "./plugin-admin.ts";
