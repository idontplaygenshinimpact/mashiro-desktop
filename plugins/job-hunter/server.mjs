// 全量 TS 升级工单阶段 4（插件）：plugins/job-hunter/server.mjs → .ts 后保留的一行桶
// 原因：插件入口是按路径约定加载的（加载器/manifest 指向 server.mjs），tests/routes-registry.test.mjs
// 也直接 import 该路径 → 保留同名 .mjs 一行桶，协议入口与调用方零改动
export * from "./server.ts";