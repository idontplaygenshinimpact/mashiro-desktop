// 桶化（全量 TS 升级工单）：实现已迁至 lib/review.ts——本桶保持 30+ 调用方零改动
// （widget / 插件 #lib 别名 / lib/* 各模块 / tests / scripts 的 .mjs 导入路径全部继续可用；
//  review.ts ↔ memory.mjs 的循环依赖结构与原 .mjs 一致：memory 侧动态 import 打破，安全）
export * from "./review.ts";
