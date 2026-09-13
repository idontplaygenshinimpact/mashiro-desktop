// 全量 TS 升级工单阶段 3：lib/routes/router.mjs → .ts 后保留的一行桶（调用方零改动）
// 调用方：widget.mjs（createRouter）、lib/routes/*（各业务域注册）与 tests/契约覆盖断言
export * from "./router.ts";
