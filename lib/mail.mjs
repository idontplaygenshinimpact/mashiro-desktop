// 全量 TS 升级工单阶段 3：lib/mail.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/routes/core.mjs、lib/loop.mjs、plugins/job-hunter/routes/mail.mjs、
//         plugins/job-hunter/server.ts、widget.mjs（定时检查）与 tests/mail.test.mjs
export * from "./mail.ts";
