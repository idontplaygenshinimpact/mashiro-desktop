// 全量 TS 升级工单阶段 3：lib/edge-session.mjs → .ts 后保留的一行桶（调用方零改动）
// 说明：本模块目前无运行时调用方（当前牛客抓题走 zhenti.ts 的常驻 headed 会话）；
// 保留导出供 Edge 登录态复用场景接入（SSRF 护栏测试也按本模块名做源码扫描）
export * from "./edge-session.ts";
