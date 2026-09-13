// 全量 TS 升级工单阶段 3：lib/career.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：14 处（lib/loop、tools/impl-*、greeting、patrol、rss、job-match、quiz、widget.mjs、
//         插件路由与 tests）——全部按 .mjs 路径 import，桶化后零改动
export * from "./career.ts";
