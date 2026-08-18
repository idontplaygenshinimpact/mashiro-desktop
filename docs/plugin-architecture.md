# 真白（Zhenbai）开源插件化架构方案

> 目标：桌宠「真白」作为**开源宿主应用**，秋招助手是第一个插件，第三方开发者可以写插件。
> 参考：DeepSeek Harness（DSH）的分层 patch 模式 + Koishi/Cordis 的插件生态模式。

---

## 0. 开源定位（新维度）

| 项 | 决策 | 理由 |
|---|---|---|
| 许可证 | **MIT**（核心代码） | 宽松，插件生态友好；第三方资产（Live2D 模型 ISC）可再分发 |
| 仓库 | 单仓库（根即宿主 + `plugins/` 目录） | 个人项目规模，pnpm workspace 过重；插件增多后再拆 |
| 语言 | 代码/注释中文为主，README 中英双语（DSH 式 `English \| 中文`） | 面向中文桌宠社区，同时不挡海外贡献者 |
| CI | GitHub Actions：单测全量 + Windows 构建验证 | 639 测试作为门禁，开源后贡献者代码必须过 CI |
| 敏感资产 | `data/`、`models/`、`.env`、自训声音资产**不进仓库** | 隐私 + 体积；README 说明首次运行自动生成/需自备 |
| 示例插件 | `plugins/plugin-template/`（hello 插件，协议即文档） | 新贡献者照抄即可写插件 |

---

## 1. 现状盘点

### 1.1 当前形态：单进程平铺

```
桌面壳（Electron）                widget 服务（Node HTTP :8899）      面板（renderer）
├─ main.mjs：窗口/托盘/Live2D     ├─ widget.mjs：路由注册 + 定时任务    ├─ panel.html：9 个 tab
├─ lib/：widget守护/window-state  ├─ lib/routes/*.mjs（13 域）         ├─ panel-*.js（5 文件）
├─ voice-pack.mjs：语音播放       ├─ lib/*.mjs（interview/study/…）    └─ vad.js
└─ preload.js：IPC 桥             └─ mianshi.db（单库）
```

模块已按域拆好（13 route 域 + 5 面板文件），缺的是**插件协议层**。

### 1.2 核心 vs 插件候选

| 层 | 内容 | 归属 |
|---|---|---|
| **真白核心** | 窗口/托盘/拖拽/Live2D/气泡、voice-pack 播放、面板宿主框架、widget 守护、token 鉴权、设置框架、**插件加载器**、插件管理页 | 核心（保留） |
| **秋招助手** | 面试/学习清单/复习卡/题库/真题/校招/邮件日程/专注/知识库/对话/爬取/自检/巡检 | **插件①** |
| 未来插件 | 日语陪练、桌宠养成、番茄钟独立版、天气/日程… | 插件②③（社区） |

---

## 2. 目标架构

```
zhenbai/                          # GitHub 仓库（单仓库）
├─ desktop/                        # 真白宿主：Electron 壳（窗口/托盘/Live2D/语音/面板宿主）
├─ widget-host.mjs                 # 服务宿主：router + db + settings + scheduler + 鉴权
├─ plugin-loader.mjs               # 插件发现/加载/生命周期（核心新增）
├─ plugins/
│  ├─ job-hunter/                  # 秋招助手（当前全部业务迁入）
│  │  ├─ manifest.json
│  │  ├─ server.mjs                # （原 lib/routes/*.mjs + 业务 lib）
│  │  ├─ panel/                    # （原面板功能区块）
│  │  └─ README.md
│  ├─ plugin-template/             # 示例插件（脚手架，新插件照抄它）
│  └─ <community-plugin>/          # 第三方插件（clone 即用）
├─ docs/                           # 架构 / 插件开发指南 / 贡献指南
├─ .github/workflows/ci.yml
├─ LICENSE（MIT）
└─ README.md（English | 中文）
```

### 2.1 插件协议（manifest.json，字段最小化 + 版本化）

```json
{
  "manifestVersion": 1,
  "id": "job-hunter",
  "name": "秋招助手",
  "version": "0.1.0",
  "description": "面经采集 / 模拟面试 / 学习清单 / 复习卡 / 校招投递 / 真题",
  "author": "zhenbai-community",
  "license": "MIT",
  "api": { "min": "0.1.0" },
  "server": "server.mjs",
  "panel": {
    "tabs": [ { "id": "interview", "label": "🎤 面试", "section": "interview" }, ... ],
    "settings": [ { "key": "llm_api_key", "type": "password", "group": "AI 模型", "default": "" }, ... ]
  },
  "schedules": [ { "id": "mail-check", "every": "30m", "fn": "checkMail" } ],
  "enabled": true
}
```

**协议稳定三件套**（开源核心要求）：
1. `manifestVersion` + `api.min`：宿主升级不破坏旧插件，插件声明所需宿主版本
2. `plugins/plugin-template/`：协议的可运行文档，新插件照抄
3. 加载失败隔离：单插件 try-catch + 健康检查 + 设置中心「插件管理」页显示错误原因

### 2.2 注册点（对齐现有代码，改动面最小）

| 现有写法 | 插件化后 |
|---|---|
| `registerStudyRoutes(router, { getCorsOrigin, laneSubmit })` | 插件 `server.mjs` 导出 `register(api)`，api = `{ router, db, settings, scheduler }`——**签名不变，调用方换成加载器** |
| widget.mjs 硬编码 `setInterval(checkMail…)` | manifest `schedules` 声明，宿主统一调度 |
| 面板 HTML 静态 tab | 核心 tab（对话/设置/驾驶舱）静态；插件 tab 由宿主按 manifest 注入 |
| 设置中心手写表单 | 插件声明 settings 描述，宿主自动渲染 |
| DB 表 | 新插件表 `plg_<id>_` 前缀；**存量表不动** |
| preload kanban 桥 | 按插件分组挂载，插件命名空间 `window.kanban.<pluginId>.xxx` |

### 2.3 层与优先级（借鉴 DSH 层栈）

```
核心层（真白壳）→ 插件层（按启用顺序叠加）
```
- 同 key 设置：合并优先，插件声明 `override: true` 才覆盖核心默认（DSH patch 语义）
- 路由冲突：核心 `/api/core/*` 保留；插件路由自动前缀 `/api/plg/<id>/*`，避免互相踩

---

## 3. 插件分发形态（开源生态，三档渐进）

| 形态 | 机制 | 谁用 | 何时做 |
|---|---|---|---|
| **A. 仓库目录** | `plugins/<id>/` clone 即用，manifest 声明启用 | 大多数用户（git clone 仓库就有秋招助手） | 阶段 1 |
| **B. npm 包** | `zhenbai-plugin-*` 发布到 npm，加载器从 node_modules 发现（DSH 同款解析） | 高级开发者/自动化安装 | 阶段 3 |
| **C. 插件市场** | 面板「插件市场」页：`plugins.json` 索引（id/仓库/版本/描述）→ 一键 git clone 进 plugins/ | 普通用户发现插件（Koishi 市场简化版） | 阶段 3+ |

A/B 协议完全一致（manifest + register），只是发现路径不同——先 A 后 B/C，不返工。

---

## 4. 迁移路线（4 阶段，每阶段可独立交付、可回滚）

### 阶段 0：注册中心收敛（1-2 天，零行为变化）
- widget.mjs 里 13 个 `registerXxxRoutes` 收拢到 `lib/registry.mjs`；定时任务集中声明
- 639 测试护航，全绿即完成

### 阶段 1：插件框架 + 秋招助手迁入（3-5 天，核心交付）
- `plugin-loader.mjs`：扫 `plugins/*/manifest.json` → 校验 → 按序 `register(api)` → 挂 schedules
- `plugins/job-hunter/`：lib/routes 13 域 + 业务 lib + 定时任务**原样 git mv**（逻辑零改动）
- widget.mjs 瘦身为：鉴权 + 插件加载 + 核心路由
- **验收**：639 全绿 + 手动全功能走查

### 阶段 2：面板扩展点（2-3 天）
- tab 区「核心静态 + 插件动态」；面板脚本按插件拆分
- 设置中心表单动态化（插件声明 → 自动渲染）
- `plugins/plugin-template/` 示例插件落地（hello 插件）
- **验收**：模板插件能独立跑通，即协议对外可用

### 阶段 3：开源配套（2-3 天）
- LICENSE(MIT) + README 中英双语 + docs/plugin-dev.md（插件开发教程）
- GitHub Actions：`npm test` 全量（windows + linux 单测；windows 构建）作为 PR 门禁
- 设置中心「插件管理」页：列表/启用/禁用/错误显示
- 第二个真实插件验证（如"番茄钟独立版"从核心拆出）

---

## 5. 与 DSH / Koishi 的对照

| 机制 | 借鉴？ | 落地方案 |
|---|---|---|
| 声明式 manifest + 分层合并（DSH） | ✅ | manifest + 核心层<插件层 + 合并优先 override 显式 |
| npm 依赖即插件（DSH/Koishi） | ⏳ | 形态 B（阶段 3），协议先行 |
| 插件市场（Koishi） | ⏳ | 形态 C（阶段 3+），plugins.json 索引 + 一键安装 |
| 示例插件即文档（Koishi 惯例） | ✅ | plugin-template 阶段 2 落地 |
| 中英双语 README（DSH） | ✅ | 阶段 3 |
| Cordis 事件总线 / HMR | ❌ | 路由注册模式足够，不引复杂度 |

---

## 6. 风险与护航

| 风险 | 对策 |
|---|---|
| 迁移回归 | 639 测试（含 28 个 jsdom 面板交互）作门禁，阶段验收全绿才前进 |
| 面板跨文件全局依赖 | jsdom 逐 tab 护航（现有用例覆盖主路径，迁移时补漏） |
| DB 表名 | 存量表不动，新插件表 `plg_` 前缀 |
| 插件拖垮宿主 | 单插件隔离 + 健康检查 + 明确报错 |
| 开源后协议不稳定 | manifestVersion + api.min 版本契约；模板插件冻结协议 |
| 隐私资产泄漏 | .gitignore（data/models/.env）+ 自训声音不入库 + README 说明 |
| 过度设计 | 阶段 0/1 只做注册中心 + 目录边界；市场/CI/文档按阶段交付 |

---

## 7. 一句话总结

**把"按域拆文件"升级为"按插件拆目录 + 一份版本化 manifest + 一个加载器"**，核心只留壳；开源三件套（MIT + 示例插件 + CI 门禁）让第三方贡献者照模板就能写插件，协议版本化保证生态长期稳定。
