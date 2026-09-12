// 全量 TS 升级工单阶段 3：lib/job-platforms.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：lib/tools/exec-tools.ts（惰性 import）、plugins/job-hunter/routes/misc.mjs、tests/job-platforms.test.mjs
export * from "./job-platforms.ts";
