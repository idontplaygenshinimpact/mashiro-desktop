// 全量 TS 升级工单阶段 4：desktop/renderer/api-client.mjs → .ts 后保留的一行桶（Vite 子项目零改动）
// 调用方：panel-react/src/api.js、panel-vue-review/src/api.js（从 ../../api-client.mjs 复用）
export * from "./api-client.ts";