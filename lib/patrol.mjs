// 全量 TS 升级工单阶段 3：lib/patrol.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（组装 createPatrol + 排程）、tests/patrol.test.mjs、tests/integration/widget-boot-race.test.mjs
export * from "./patrol.ts";
