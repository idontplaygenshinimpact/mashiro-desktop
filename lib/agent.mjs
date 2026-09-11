// 桶化（全量 TS 升级工单）：实现已迁至 lib/agent.ts（阶段 2 编排层）——本桶保持 35+ 调用方零改动
// （MCP server / jobs / loop / skills / 测试 / scripts 的 .mjs 路径全部继续可用）
export * from "./agent.ts";
