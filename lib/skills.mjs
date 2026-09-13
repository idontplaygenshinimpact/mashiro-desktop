// 全量 TS 升级工单阶段 3：lib/skills.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（技能加载/热重载）、lib/agent.ts、lib/scenarios.ts、
//         plugins/job-hunter/routes/*（技能面板）与 tests/skills.test.mjs
export * from "./skills.ts";
