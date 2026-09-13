// 全量 TS 升级工单阶段 3：lib/backup.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/db.mjs（顶层 applyPendingRestore）、lib/self-check.ts、widget.mjs、
//         plugins/job-hunter/routes/misc.mjs（备份/恢复路由）与 tests/backup.test.mjs
export * from "./backup.ts";
