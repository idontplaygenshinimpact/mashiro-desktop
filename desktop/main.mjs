// 看板娘 Electron 主进程（实现已迁至 main.ts，此处仅保留同名薄桶）
// 全量 TS 升级工单阶段 4（桌面）：实现迁至 main.ts，main.mjs 保留同名薄桶
// （package.json "main" 与 electron-builder build.files 均指向 desktop/main.mjs → Electron 入口与打包路径零改动）
export * from "./main.ts";
