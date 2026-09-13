// 全量 TS 升级工单阶段 3：lib/interview-session.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/interview.mjs（对外聚合桶）、plugins/job-hunter/routes/interview.mjs、
//         widget.mjs（面试状态轮询）与 tests/interview.test.mjs、tests/integration/*
export * from "./interview-session.ts";
