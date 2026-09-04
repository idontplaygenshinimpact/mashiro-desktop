# 渐进式 TypeScript 升级工单

> 背景（探索结论）：2025 主流通用 agent 核心代码 ≈90% 是 TypeScript（Claude Code / OpenCode / Continue / Cursor 全 TS）；唯一例外是 OpenAI Codex CLI 因安全与性能从 TS 迁到 Rust，Aider 是 Python 老项目。我们项目现状：**208 个 .mjs / 45K 行**，Electron + 前端本来就是 TS 生态，devDependencies 已有 typescript + esbuild（可直接打包 TS）。结论：**升级 TS 是主流方向，但不必全量重写——渐进式**。

---

## 一、三个核心问题

| 问题 | 现状 | 影响 |
|---|---|---|
| **① 无类型检查** | lib 全 .mjs，typecheck 只覆盖 desktop/renderer 的 ts | 核心 agent 逻辑（ai.mjs / tools / memory）改错字段运行时才炸 |
| **② 无类型文档** | 函数签名靠注释，跨模块传参（如 tool.run(args)）全靠人脑对齐 | 新功能开发慢、重构风险高 |
| **③ 全量迁移成本高** | 45K 行全迁 TS 工作量大，面试前时间宝贵 | 收益边际递减，不值得 |

## 二、渐进式方案（三步）

### 任务 1：JSDoc + checkJs 增量检查（零迁移成本）

```
① 根目录加 jsconfig.json：checkJs: true + 只对 lib/ 开 strict 检查
   （allowJs: true, checkJs: true, strict: true, noEmit: true）
② 核心模块先补 JSDoc 类型标注（@param/@returns/@typedef）：
   lib/ai.mjs、lib/memory.mjs、lib/tools/impl-*.mjs、lib/web-search.mjs
③ npm run typecheck 扩展为同时跑 tsc --noEmit（含 lib/ 的 checkJs）
④ 目标：typecheck 全绿（现有 .mjs 不报错或报错清零）
```

### 任务 2：核心模块迁移 .ts（按需迁移）

```
① 只迁最核心、最常改的模块（esbuild 已支持直接打包 TS）：
   lib/ai.mjs → lib/ai.ts（topicDirection/ADAPTATION_CONSTRAINT 等提示词常量 + 调用链）
   lib/memory.mjs → lib/memory.ts（相似度判断、GENERIC_3GRAM）
   lib/tools/ 核心 impl（search/fetch/interview）
② 迁移时顺手定义 @typedef 共享类型（如 ToolResult、AgentMessage）放 lib/types.ts
③ 其余 200 个 .mjs 保持不动——.ts 与 .mjs 可互 import（esbuild 打包无感）
④ 目标：核心模块有真实类型检查，改字段编译期报错
```

### 任务 3：全量迁移（可选，面试后）

```
① 剩余 .mjs 按依赖顺序批量迁（脚本辅助：先迁无依赖叶子模块）
② 目标：全项目 .ts，typecheck 全覆盖
③ 不做也行——任务 1+2 已拿到 80% 收益
```

## 三、验收

```
① npm run typecheck 全绿（含 lib/ checkJs）
② 核心模块（ai/memory/tools）已迁 .ts 或带完整 JSDoc
③ 故意改错一个字段类型 → typecheck 报错（证明检查生效）
④ 全部 35 个测试仍通过（npm test）
⑤ 应用功能无回归（讲解/搜索/复习卡正常）
```

## 四、面试叙事素材

```
"调研了主流 agent 实现（Claude Code/OpenCode 全 TS、Codex 因性能迁 Rust），
结合项目 45K 行 .mjs 的规模，做了渐进式 TS 升级：
先 JSDoc+checkJs 零成本拿到类型检查，再按依赖热度迁核心模块，
避免全量重写的高成本低收益。"
——体现工程判断力：不跟风全量重写，按 ROI 决策
```
