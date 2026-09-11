// 桶化（全量 TS 升级工单）：实现已迁至 lib/memory.ts——本桶保持 50+ 调用方零改动
// （widget / 插件 #lib 别名 / lib/* / tests / scripts / skills 的 .mjs 路径全部继续可用；
//  tests/helpers 的 mock.module URL 也继续匹配；memory.ts ↔ review.ts 循环依赖
//  与原 .mjs 一致：memory 侧动态 import 打破，安全）
export * from "./memory.ts";
