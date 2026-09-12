// 全量 TS 升级工单阶段 3：lib/self-check.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（启动后惰性 import）、tests/self-check.test.mjs（按 .mjs 路径加载）
export * from "./self-check.ts";
