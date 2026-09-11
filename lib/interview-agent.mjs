// 全量 TS 升级工单阶段 3：lib/interview-agent.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/interview-session.mjs、lib/interview-start.mjs、lib/interview.mjs（说明注释）
export * from "./interview-agent.ts";