// 全量 TS 升级工单阶段 3：lib/db.mjs → .ts 后保留的一行桶（42 个调用方零改动）
// 调用方：lib/*（几乎全部模块）、plugins/**、widget.mjs、mcp-server.mjs、scripts/** 与 tests/**
// 注意：桶在 import 时即触发 db.ts 的顶层初始化（建表/迁移/恢复钩子）——与迁移前行为一致
export * from "./db.ts";
