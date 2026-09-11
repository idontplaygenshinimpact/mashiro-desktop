// 全量 TS 升级工单阶段 3：lib/context-providers.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：mcp-server.mjs（4 处动态 import executeProviderTool）
export * from "./context-providers.ts";