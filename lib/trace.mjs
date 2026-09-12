// 全量 TS 升级工单阶段 3：lib/trace.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/agent.ts、lib/autonomy.ts、lib/mcp-gate.ts、lib/permission.ts、lib/routes/core.mjs、tests/trace.test.mjs
export * from "./trace.ts";
