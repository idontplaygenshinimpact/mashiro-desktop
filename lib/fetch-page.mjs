// 全量 TS 升级工单阶段 3：lib/fetch-page.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方（23 处）：lib/jobs、job-collect、job-match、knowledge-base、learning、oj、patrol、rss、zhenti、
//   edge-session、tools/impl-search、loop、插件平台模块（boss）与 tests/fetch-page.test.mjs
export * from "./fetch-page.ts";
