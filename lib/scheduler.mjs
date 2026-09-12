// 全量 TS 升级工单阶段 3：lib/scheduler.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（静态 import createScheduler）、tests/scheduler.test.mjs（按 .mjs 路径加载）
export * from "./scheduler.ts";
