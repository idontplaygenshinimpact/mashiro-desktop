// 全量 TS 升级工单阶段 3：lib/dreaming.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（夜间巩固惰性 import）、tests/dreaming.test.mjs（按 .mjs 路径加载）
export * from "./dreaming.ts";
