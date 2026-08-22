# 贡献指南

感谢你愿意为 **真白 · Mashiro Desktop** 贡献力量！这是一个"宿主 + 插件"架构的桌面 AI 应用：真白是 Electron 桌宠宿主，秋招助手是跑在宿主上的能力插件。任何方向的贡献都欢迎——代码、文档、测试、Issue 反馈。

## 项目速览

| 层 | 说明 |
|---|---|
| `desktop/` | Electron 宿主：桌宠（Live2D/语音）+ 面板（渲染层，`renderer/` 5 个模块文件） |
| `plugins/job-hunter/` | 插件①秋招助手：面经爬取/模拟面试/学习清单/复习卡/知识库/求职闭环/对话 agent（12 个业务路由域，一个整体插件） |
| `plugins/plugin-template/` | 示例插件模板（**协议即文档**——新插件照抄即写） |
| `lib/` | 共享业务库（宿主与插件共用，单一数据源） |
| `widget.mjs` | 后台数据服务（HTTP :8899）：鉴权 + 核心路由 + 插件加载 + 定时任务 |
| `tests/` | 725+ 用例（单元 + 集成） |

## 环境准备

- Node.js >= 22（`node:sqlite` 内置，无需额外依赖）
- Windows 10/11（桌宠依赖 Win32 API；纯后端开发 Linux/macOS 也可跑 `npm test`）
- DeepSeek API Key（可选，测试全部走 mock LLM，不需要真实 key）

```bash
git clone https://github.com/idontplaygenshinimpact/mashiro-desktop.git
cd mashiro-desktop
npm install
npm test        # 全量测试（mock LLM，无需 API key）
npm run lint    # ESLint
npm run typecheck
```

## 开发命令

| 命令 | 说明 |
|---|---|
| `npm run` | 启动完整应用（桌宠 + 面板 + 后台服务） |
| `npm test` | 全量测试（单元 + 集成，mock LLM） |
| `npm run test:unit` | 仅单元测试 |
| `npm run test:integration` | 仅集成测试（真实拉起 widget 进程） |
| `npm run test:module` | 按模块跑测试（交互式选择） |
| `npm run lint` / `npm run typecheck` | 静态检查 |
| `npm run check:renderer` | 验证渲染层 bundle 与源码一致 |
| `npm run build:renderer` | 重新打包渲染层（改 renderer 源码后运行） |

## 测试规范（重要）

测试是这个项目的"契约"：**测试绿 ≠ 功能对**。请遵守：

1. **每个新功能/修复必须带测试**。修 bug 先写能复现该 bug 的回归测试，再修代码。
2. 测试隔离：
   - 临时 DB：`setupTempDb("label")`（必须在 import 被测模块之前调用）
   - mock LLM：`mockLLM()` + `setLlmResponses(...)`（断言 prompt 用 `getLastMessages()`）
   - 临时输出目录：`process.env.MIANSHI_OUTPUT_DIR`（防污染真实 `output/`）
3. 跑测试：`node --experimental-test-module-mocks --test "tests/*.test.mjs"`（单文件直接指定路径）。
4. 涉及真实数据（`data/`、`output/`）的操作一律用临时目录——**绝不覆盖真实存档**。

## 架构要点（改动前必读）

- **宿主 + 插件**：业务能力必须在插件里（`plugins/<id>/manifest.json` + `server.mjs` 的 `register(api)`），宿主只提供基础设施（路由/DB/设置/鉴权）。新插件从 `plugins/plugin-template/` 复制。
- **纵向拆分**：路由按域拆文件（`lib/routes/*.mjs`、`plugins/job-hunter/routes/*.mjs`），通过 router 注册，可独立测试。
- **数据安全**：所有用户数据进 SQLite（WAL）；`lib/backup.mjs` 自动备份（每天一次，保留 10 份），恢复走"标记 → 重启替换 → 恢复前自动快照"链路。改数据层时保持这个契约。
- **提示注入防护**：外部内容（爬取页面/知识库）进 LLM 上下文必须经 `sanitizeExternal(x).wrapped` 包裹为不可信数据（历史教训：漏取 `.wrapped` 会让 LLM 收到 `[object Object]`）。
- **SSRF 防护**：所有网络抓取必须走 `lib/fetch-page.mjs` 的 choke point（IP 校验/内网拒绝）。

## 提交规范

- 提交信息用中文，格式：`<type>(<scope>): <摘要>`——`fix(interview): ...` / `feat(plugins): ...` / `test(routes): ...` / `docs(README): ...`
- 一个提交一个逻辑变更；测试与代码同提交。
- 提交前必跑：`npm test` + `npm run lint`（CI 也会跑）。

## Issue / PR

- Bug 报告：用模板（环境/复现步骤/预期 vs 实际/日志）。附上 `data/widget-error.log` 或控制台报错更有帮助。
- 新功能：先开 Issue 讨论设计（尤其涉及数据模型或插件协议变更）。
- PR：描述改动 + 测试覆盖 + 截图（涉及面板 UI 时）。CI 全绿是合并前提。

## 文档

- 插件化架构：`docs/plugin-architecture.md`
- 目录结构/功能全景：`README.md`
