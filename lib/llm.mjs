// 桶化（全量 TS 升级工单）：实现已迁至 lib/llm.ts——本桶保持 60+ 调用方零改动
// （lib/*、skills/*、scripts、tests/helpers 的 mock.module URL 全部继续可用）
export * from "./llm.ts";
