// 全量 TS 升级工单阶段 3：lib/focus.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（分心监督/状态轮询）、lib/loop.mjs、plugins/job-hunter/routes/focus.mjs、
//         plugins/job-hunter/server.ts 与 tests/focus.test.mjs
export * from "./focus.ts";
