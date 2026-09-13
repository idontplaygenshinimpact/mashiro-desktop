// 全量 TS 升级工单阶段 3：lib/personal-projects.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/rag.ts、lib/interview-agent.ts、lib/interview-start.ts、lib/tools/exec-tools.ts、
//         skills/project-doc、skills/project-guide、mcp-server.mjs、plugins 路由与 tests/*
export * from "./personal-projects.ts";
