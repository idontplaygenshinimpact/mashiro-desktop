# 真白 · Mashiro Desktop（mashiro-desktop）

> 🎀 桌面 AI **宿主「真白」+ 第一个插件「秋招助手」**。真白是 Electron 桌宠宿主（Live2D / 语音 / 面板框架 / 设置中心），秋招助手是跑在宿主上的能力插件（面经采集 / 模拟面试 / 学习清单 / 复习卡 / 知识库 / 对话 agent / 校招闭环）。
> 2026-08 起升级为**事件驱动自主桌宠**：感知（Claude Code 会话 watcher）→ 决策（自主规则引擎）→ 装配（场景技能子集）→ 表达（气泡/语音），并落地 **API 契约层（zod）与双层 AI 评测体系（真实消融基线）**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![CI](https://github.com/idontplaygenshinimpact/mashiro-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/idontplaygenshinimpact/mashiro-desktop/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/mashiro-mcp?color=cb3837&label=mashiro-mcp)](https://www.npmjs.com/package/mashiro-mcp) ![Node](https://img.shields.io/badge/Node-%3E%3D22-5fa04e) ![Tests](https://img.shields.io/badge/tests-924%2B-8a5adc) ![Platform](https://img.shields.io/badge/Windows-10%2F11-0078d6)

---

## 架构：宿主 + 插件 + 事件驱动内核

| 层 | 内容 | 状态 |
|---|---|---|
| **真白（宿主）** | Electron 透明窗口 + Live2D 真白、点击对话（短句日语语音）、气泡提醒、全屏自动隐藏、托盘常驻、开机自启、设置中心、本地 ASR 语音输入 | ✅ 核心 |
| **秋招助手（插件①）** | 面经爬取 / 学习闭环 / 专项练习 / 模拟面试 / 求职闭环 / 知识库 / 对话 agent / 学习计划引擎（12 个业务路由域） | ✅ 内置（plugins/job-hunter） |
| **事件驱动内核** | 事件总线 + 自主决策（off/notify/full 三级刹车）+ CC 会话 watcher（Claude Code 伴侣）+ 场景技能装配 | ✅ P0+P1 已接线 |
| **契约层（Phase 2）** | zod 契约：15 个高频路由 input/output 校验 + SSE 事件 union + preload/renderer 类型化（kanban-api.d.ts，checkJs 校验 74 方法一致）+ 117 处硬编码收编 | ✅ |
| **双层评测（Phase 评测）** | Layer A 真实模型基线 + Layer B mock agent 机制；数据集治理（sha256）/ 成本延迟指标 / 分层回归门禁 / 消融基线 / 每周徽章 | ✅ |

**秋招助手（插件①）能力一览**：

| 模块 | 作用 |
|---|---|
| **爬取引擎** | 自动逛牛客/掘金/CSDN，抓取前端 & AI Agent 面经/笔试题，AI 筛选出**具体题目**并完整讲解（结论/原理/JS实现/边界），归档 Markdown |
| **学习闭环** | 从产出提炼"优先学习清单" → 勾选完成 → 复盘出题 → 判分 → 错题自动进入**薄弱点**，下次优先学；FSRS 间隔复习 + 选择题自测 + 到期提醒 |
| **学习计划引擎** | 任意"学一段长时间内容"→ 计划实体 + 学习事件流（唯一事实源）+ 趋势聚合 + 即时反馈（与判题/复习/清单解耦的通用引擎） |
| **专项练习** | 牛客 TOP101 算法题 + **手写/算法题库 448 道**（281 道带自动判题测试，worker 沙箱隔离；答错回流薄弱点与复习卡） |
| **模拟面试** | **面试官 agent 化**（出题前可检索题库/项目源码/知识库/薄弱点）+ 五维评分 + 追问深挖 + **动态轮数**（薄弱点未考完自动加试）+ 复盘报告回流；**继续上一场**（关面板不丢进度）+ 历史复盘回看 |
| **对话闭环** | 对话 agent（**37 个内置工具** + MCP 工具 + 技能工具，权限分级审批）——可反哺学习清单、建复习卡、挂学习任务；**多会话**隔离；上下文压缩 + 追问语义缓存 |
| **求职闭环** | 简历 → 方向画像 → 岗位匹配/投递 → 笔试日程 → 面试邀约（邮箱自动识别）→ 全节点回流（规则引擎给"现在最该做什么"） |
| **本地知识库** | FTS5 关键词检索（零模型零内存），对话/复习/出题可引用 |

**事件驱动自主（P0+P1，2026-08 落地）**：

```
感知（CC 会话 jsonl watcher / 内部 hooks / 定时任务）
  → 事件总线（lib/events.mjs 统一事件模型）
  → 自主决策（lib/autonomy.mjs：规则驱动，off/notify/full 三级，防抖/寂静期/每日预算刹车）
  → 场景装配（lib/scenarios.mjs：interview/companion/study 场景 → 技能子集，agent 只注入当前场景技能）
  → 表达（petSay 气泡 + 语音）
```

Claude Code 伴侣：桌宠能看到 CC 在干什么（会话开始/工具调用/回复/结束），用气泡陪伴播报——零侵入（只读 jsonl 会话文件元数据，不落正文内容）。

> **个人数据闭环**：简历/岗位/日程/学习进度 全链路互通，自动识别邮箱面试邀约、投递状态实时同步、笔试进入统一日程表——不用手动搬数据。

### 插件化（已完成三个阶段）

真白按"宿主 + 插件"设计演进（manifest 声明 + 加载器 + 设置命名空间 + 健康检查 + 面板扩展点动态渲染 + 插件市场一键安装）：

- **阶段 1**：✅ 插件协议落地（`manifest.json` + 加载器），秋招助手迁入 `plugins/job-hunter/`（12 业务域）
- **阶段 2**：✅ 示例插件模板 `plugins/plugin-template/`（协议即文档）+ 加载器扩展（settings 命名空间 `plg_<id>_` 前缀 / init 钩子 / health 检查 / panel 声明校验）
- **阶段 3**：✅ 插件管理（已装插件列表 / 启停开关 / 市场一键安装 `POST /api/plugins/install`）

完整方案见 [`docs/plugin-architecture.md`](docs/plugin-architecture.md)。

---

## 快速开始

### 环境要求

- Node.js >= 22
- Windows 10/11（桌宠依赖 Win32 API）
- DeepSeek API Key（或任意 OpenAI 兼容接口）

### 安装

```bash
cd mashiro-desktop
npm install
# 国内网络需指定镜像下载 Chromium：
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"
npx playwright install chromium
```

### 配置

**全部可在面板「⚙️ 设置」配置，无需改文件**：

| 配置项 | 面板入口 | 说明 |
|---|---|---|
| API Key / Base URL / 模型名 | 设置 → LLM 服务配置 | 接任意 OpenAI 兼容端点（含本地 Ollama）；配了 Base URL 即单端点直连 |
| 方向画像 / 知识树模板 | 设置 → 方向画像 / 知识树 | 转方向/开源复用改这里即可，全链路跟随 |
| 邮箱（自动检查开关） | 设置 → 邮箱 | 授权码仅存本机；每 30 分钟自动拉取识别面试邀约 |
| 自动巡检 + 每日 token 预算 | 设置 → 自动化 | 关注点定时搜新面经 → 讲解 → 通知；token 上限防超支 |
| 本地知识库（RAG） | 设置 → 本地知识库 | 默认关；**纯关键词检索（FTS5）零模型零内存** |
| 招聘平台（BOSS） | 校招 Tab → 平台账号 | 启用/登录态/投递设置/招呼语 |
| 自主模式（事件驱动） | 环境变量 `MIANSHI_AUTONOMY` | off / notify（默认）/ full 三级；`MIANSHI_AUTONOMY_BUDGET` 每日表达上限 |

> 兜底：`.env` 仍生效（`DEEPSEEK_API_KEY`/`MIANSHI_MODEL`/`MIANSHI_PROVIDERS` 等），面板配置优先。

### 启动

```bash
# 一键启动脚本（无黑窗，重复双击会被单实例锁拦截并聚焦已运行窗口）
start-kanban.bat

# 或直接命令（桌宠会自动拉起后台数据服务）
node node_modules\electron\dist\electron.exe desktop\main.mjs
```

**改代码后一键重启**：面板右上角「♻️」按钮（桌宠 + 后台服务一并重启，约 3-5 秒）。开机自启为「计划中」（当前启动脚本不写注册表，需手动添加或每次双击启动）。

---

## MCP 接入其他 AI 工具（npm 安装）

秋招助手的能力是标准 **MCP Server**（`npm i -g mashiro-mcp`），可接入任何支持 MCP 的 AI 工具（Claude Code / Cline / Cursor / OpenCode）：

```bash
npm install -g mashiro-mcp   # npmjs 官方源（Node >= 22）
# 国内优先 GitHub Packages 镜像：
npm install -g @idontplaygenshinimpact/mashiro-mcp --registry=https://npm.pkg.github.com/
```

Claude Code 配置（`.mcp.json`）：

```json
{ "mcpServers": { "mashiro": { "command": "mashiro-mcp" } } }
```

**装包即连（实测）**：启动时**自动探测**你的桌宠数据目录（源码版 data/ / 打包版 Electron userData / ~/.mashiro 兜底）——已有桌宠数据的用户零配置，数据工具直接返回真实内容（学习清单/岗位/简历实测通过）；LLM key 随数据目录自动继承（设置中心配过的 key）。

9 个工具（全部只读）：

| 工具 | 能力 |
|---|---|
| `search_posts` | 搜索牛客/掘金/CSDN 前端 & AI Agent 面经帖 |
| `solve_question` | 完整讲解面试题（结论/原理/JS 实现/边界） |
| `get_study_plan` / `get_study_progress` | 学习清单与进度 |
| `start_interview` | 模拟面试官（项目拷打/八股穿插/手写收尾） |
| `get_personal_profile` / `get_jobs_status` / `get_schedule_events` / `get_project_archives` | 个人数据环境（简历/岗位/日程/项目源码档案） |

**诚实两档**：6 个数据工具零配置可用（空库优雅返回）；`solve_question`/`start_interview` 需 LLM Key（无 key 快速报错并给配置提示）。完整分发文档（工具清单/各客户端配置/使用示例/FAQ/数据权限）：**[docs/mcp.md](docs/mcp.md)**。

### 接入 DeepSeek Harness（DSH）

`dsh-mcp-client` 实例接入后，agent 获得 `mcp__mashiro__*` 工具（search_posts / solve_question / get_study_plan / start_interview / 个人数据 5 件套），可让 DSH 直接"搜面经 → 讲解 → 建清单 → 模拟面试"。

---

## 使用方式

### 1. 桌宠（推荐日常使用）

- **点击真白** → 短句应答（摸头/戳脸等部位人设）；**空闲 5 分钟** → 长句独白（GPT-SoVITS 真白声线）
- **面板**（9 个 Tab：🎤 面试 / 🔁 复习 / 📋 学习清单 / 💬 对话 / 🔍 爬取 / 🏢 校招 / 📊 驾驶舱 / 🧠 知识库 / ⚙️ 设置）
- **气泡** → 爬取进度 / 新产出 / 学习提醒 / **CC 伴侣播报**（事件驱动）
- **全屏（B站视频/游戏）** → 自动隐藏；**托盘** → 右键菜单（面板/换肤/音乐/爬取/邮箱/巡检/退出）
- **形象切换** → 真白·旅行装/水手服/私服 + 时雨，点击即换、重启记忆
- **语音输入** → 面板 🎤 说话自动转文字（本地 sherpa-onnx 离线识别，零 API key）

### 2. 预设技能（对话直接触发，6 个）

| 技能 | 触发方式 | 能力 |
|---|---|---|
| 🧾 **frontend-cheatsheet** | "讲一下事件循环/闭包/浏览器缓存…" | 八股讲解按高频考点清单覆盖追问点 |
| 🔥 **interview-warmup** | "明天面试怎么准备/面试前热身" | 5 分钟流程：摸底→搜面经→演练→收尾回流 |
| ⚖️ **tech-compare** | "React 和 Vue 哪个好" | 统一对比框架（结论→差异→本质→选型） |
| 📄 **resume-coach** | "帮我看看简历"（贴简历） | 结构化优化：亮点/风险/量化改进/面试预设问题 |
| 🏢 **company-intel** | "字节面什么" | 目标公司面经情报（TOP 考点+真题线索） |
| 🐙 **github-repo** | "React 仓库多火" | GitHub 仓库信息（stars/语言/更新时间） |

> 技能即插即用：新增 `skills/<名>/` 目录即可（`lib/skills.mjs` 的 `reloadSkills` 支持热重载，HTTP 管理路由待补）；**场景装配**（P1）下 agent 只注入当前场景技能子集（面试中/CC 陪伴/学习），省 token、降幻觉面。

### 3. 命令行爬取 / 4. 学习闭环 / 5. 专注（番茄钟 + 陪伴）/ 6. 语音交互 / 7. 本地知识库

沿用既有能力（详见 git 历史版本与本仓库 `docs/`）：

- **命令行**：`node discover.mjs`（AI 逛网模式）/ `node run.mjs`（手动处理 links.txt），产出归档 `output/<日期>_discover/`
- **学习闭环**：✨生成清单 → 勾选 → 📝复盘判分 → 错题回流薄弱点/复习卡；**学习计划引擎**：对话说"建一个 XX 计划"即创建，做题/复习/面试自动归入并按趋势给即时反馈
- **专注**：25/45 分钟番茄钟 + 黑名单分心监督（标题/进程/正则）+ 目标回流学习进度
- **语音**：112 个短句 + 26 个长句日语声线资产；`voice:synth/score/audit/train` 全套合成-评测-训练流水线（实时 TTS 句子级流水线开发中）
- **知识库**：设置开启后 FTS5 关键词检索，复习选择题可引用素材

---

## 项目结构

```
mashiro-desktop/                    # 宿主 + 插件（插件化架构，见 docs/plugin-architecture.md）
├── desktop/                        # ── 真白宿主：桌宠（Electron）──
│   ├── main.mjs                    # 主进程：窗口/托盘/守护/widget 数据注入/本地 ASR/语音播放
│   ├── kanban-api.d.ts             # 渲染层 API 全量类型声明（74 方法，checkJs 校验）
│   ├── preload.js                  # IPC 桥接（74 方法 + SSE 流封装）
│   ├── lib/                        # 主进程模块（widget-server 守护 / companion-poller 等）
│   ├── voice-pack.mjs / tts-edge.mjs  # 日语语音包播放（预设匹配 + ack 兜底）
│   └── renderer/                   # 面板 9 Tab（panel-core/study/chat/jobs/rest + api-client + vad）
├── plugins/                        # ── 插件目录 ──
│   ├── job-hunter/                 # 插件①：秋招助手（manifest + server + 12 业务路由域）
│   └── plugin-template/            # 示例插件模板（协议即文档）
├── lib/                            # ── 共享业务库（76 模块，单一数据源）──
│   ├── agent.mjs + tools/          # 对话 agent（37 内置工具，权限分级审批）
│   ├── interview.mjs / study.mjs / review.mjs / learning-plan.mjs / memory.mjs
│   ├── events.mjs / autonomy.mjs / scenarios.mjs / hooks.mjs   # 事件驱动内核（P0+P1）
│   ├── adapters/cc-watcher.mjs     # CC 会话 watcher（jsonl 增量幂等解析）
│   ├── contracts/                  # Phase 2 契约层（zod schema，前后端类型唯一事实源）
│   ├── routes/                     # 路由域（core 30 条 + withContract 契约运行时）
│   ├── eval-cost.mjs / eval-summary.mjs / eval-scoring.mjs  # 评测指标层
│   ├── data-detect.mjs             # 桌宠数据目录自动探测（MCP 装包即连）
│   └── db.mjs                      # node:sqlite 主存储（WAL，23 表 + settings KV）
├── widget.mjs                      # 后台数据服务（HTTP :8899）：139 条路由 + 18 个后台任务 + 事件内核接线
├── mcp-server.mjs                  # MCP Server（9 工具 → 外部 agent）
├── skills/                         # 6 个技能（SKILL.md 声明 + skill.mjs 可编程）
├── benchmark/                      # 双层评测数据集（38+16+12+20+12+19）+ 报告 + 趋势
├── scripts/                        # 评测/导入/语音/发布工具（50+ 脚本）
├── tests/                          # 924 用例（90 个测试文件，mock LLM 无 key 可跑）
├── docs/                           # 公开文档（mcp 分发/CC 伴侣/插件架构/技术方案；内部评估审计文档本地留存不上仓库）
├── assets/voice/                   # 自训练声线（112 短句 + 26 长句 + nanami 声线）
└── .github/workflows/              # ci.yml（全量门禁）+ weekly-eval.yml（每周评测）+ release.yml（双源发布）
```

### 渲染层选型（esbuild 主面板 + Vite 双框架子项目）

| 层 | 技术 | 选型依据 |
|---|---|---|
| 主面板（原生） | 原生 JS + **esbuild** 单入口打包 | file:// 加载场景不需要 dev server/HMR；零依赖启动快（性能对照基线） |
| 模拟面试（React 版） | **Vite 子项目**（`panel-react/`，vite 7） | 交互密集（状态机/评分可视化），HMR 开发效率；独立窗口（托盘一键切换） |
| 复习卡（Vue 版） | **Vite 子项目**（`panel-vue-review/`，vite 6） | 数据可视化（FSRS 调度/遗忘曲线 SVG），Vue 响应式系统；独立窗口 |

三套渲染层共用**同一 preload IPC 桥 + 同一业务层**（`lib/interview.mjs`/`lib/review.mjs` 零改动）——渲染层可替换性验证。子项目 `npm run build --prefix` 出静态产物（`base:'./'` 兼容 file://，CSP `'self'` 零修改）。

---

## 关键技术点

- **事件驱动自主内核**：`events.mjs`（统一事件模型 + 表达队列）→ `autonomy.mjs`（规则决策，三级模式 off/notify/full，防抖 5s/寂静期 60s/每日预算 20 条，审计 decision_ledger）→ `scenarios.mjs`（事件→技能子集，scene.json 持久化）→ `adapters/cc-watcher.mjs`（Claude Code jsonl 增量幂等解析，字节偏移，只读元数据不落正文）
- **API 契约层（Phase 2）**：`lib/contracts/` zod schema 唯一事实源——withContract 包装器（input 校验 400 VALIDATION_ERROR / output 校验 500 SCHEMA_MISMATCH）、SSE 事件 discriminated union（4 处散装 push 统一）、preload 74 方法 `kanban-api.d.ts` + checkJs 校验、117 处硬编码 8899 收编为单一 `API_BASE`
- **双层评测（Phase 评测）**：Layer A 真实模型（客观代码验证 + LLM-as-Judge 双评 + CRAG 事实判官，数据集 sha256 治理，`eval_summary.csv` 19 列回归底座）+ Layer B mock agent（pass³，故障注入）；分层门禁（硬红/黄牌）；**消融基线**（裸 prompt vs 全链路，实测 Δ judge +7pt / cover +5pt / CRAG -17pt，含判官长文校准）
- **Live2D 渲染**：pixi-live2d-display + Cubism2（`sharedTicker: true` 必须）；透明窗口 WebGL（canvas `transparent` + `showInactive`）
- **全屏检测**：koffi FFI 直调 `GetForegroundWindow`（毫秒级，替代慢速 PowerShell）
- **LLM 客户端**：统一 `llm.mjs`——failover 主+备双端点 + 3 次重试 + 空响应翻倍重试 + SSE；多 Provider 路由（`MIANSHI_PROVIDERS`）；上下文压缩（token 估算触发，70%+ 缩减实测）
- **记忆防污染**：origin 溯源（owner/agent/untrusted）——爬虫提炼的伪知识点不注入 prompt
- **Skills 插件 + 场景装配**：SKILL.md 声明式 + skill.mjs 可编程（tools/hooks/权限），`skill__<skill>__<tool>` 命名空间，热重载；P1 场景激活子集（agent 只注入当前场景技能）
- **可观测性**：`trace_llm`/`trace_tools` 每次调用记录 token/耗时/成败；面板运行监控实时可见

---

## 评测（Benchmark）

<!-- EVAL_BADGE -->

双层评测体系 + 指标/门禁/消融/可视化，报告存 `benchmark/reports/`（`eval_summary.csv` 为回归底座）：

### Layer A：模型基线（`npm run bench` / `bench:quick` / `bench:ablation`）

- **讲解质量**：**38 道**真实面试题（code/predict/coverage/trace 四型），客观判定为主（代码测试断言 / stdout 比对 / 必考要点覆盖率）+ LLM-as-Judge 双评 + CRAG 事实判官
- **分类/检测/匹配**：16 分类 / 12 检测 / 12 静态匹配（`benchmark/static.json`）
- **指标**：综合分 + pass@1 + 成本（tokens/USD，solver vs judge 分账）+ 延迟（p50/p95）+ 失败分类，全部落 `eval_summary.csv`
- 判官金标校验（20 对，`--judge-check`，CI 有 key 时跑）

### 数据集治理（`npm run bench:validate`，CI 每次跑）

- 统一 envelope：`version` / `meta` / 每样本 `source`（来源可追溯）+ schema 校验 + `datasetHash`（sha256）——回归对比**同 hash 才可比**

### 回归门禁（`npm run bench:compare` / `bench:gate`）

- 同 layer ∧ 同 hash 最近两次 Δ 表；硬红（分类/检测/静态降 >3pt exit 1）+ 黄牌（讲解/真实性降 3~5pt，连续两次同向升级红）；hash 不同不跨集对比

### 消融基线（`npm run bench:ablation -- --sample N`，诚实版）

- 同题 A/B：裸 prompt vs 全链路（结构化 prompt 工程），固定 seed 随机顺序（**抽样已改 seededShuffle 随机**，非前缀切片）；**solver 输出缓存**（重跑只判 judge，降本 30%）
- **结论（诚实口径）**：消融 Δ **不稳定**——同 hash 多次运行在 **+8 ~ -13 摆动**（solver 随机性 + 判官波动，小样本下结论不可靠）。实测记录：sample=20 某次 Δ judge +7pt / Δ cover +5pt / Δ CRAG -17pt（ablation-2026-08-26T10-17.json）；最近一次 sample=8 为 Δ judge -8（ablation-latest.json）。**当前不能下"全链路优于裸 prompt"的确定结论**——这本身就是方法论发现（小样本消融的统计陷阱），继续治理中
- **判官长文校准**（实测驱动）：发现 CRAG 判官对 5000+ 字长文系统性误判 → 校准 prompt + judge-check 复用真实判官；同题 B q5 从 incorrect → correct，Δ CRAG 从 -43 → -17（校准方向有效，波动仍存）

### 为什么讲解链路不用 RAG（决策档案）

讲解刻意不引入 RAG（黑箱 vs 可解释 / 任务匹配 / 按任务分流——出题、刷题、agent 搜索仍用 `searchKnowledge`），消融 2（RAG on/off）为可选验证项。

### Layer B：Agent/Harness 能力（`npm run bench:agent`）

- mock LLM 故障注入，**与模型无关**（CI 零成本）；覆盖工具循环/参数校验/幻觉容错/上下文压缩/学习闭环数据流
- 当前结果：**19/19 通过**（首次通过口径，3 次全过一致率）

### 空响应容错 / 上下文压缩

`llm.mjs` 检测网关 `HTTP 200 + 空 content` → 自动重试/failover；上下文压缩 token 估算触发（`COMPACT_BUDGET`/`COMPACT_KEEP_RECENT` 可配），量化验证 70%+ 缩减。

---

## 工程质量门禁

> 数字为 2026-08-26 实测（已提交 HEAD）。**注意**：当前工作区含并行未提交开发（实时 TTS 流水线 / UI 审计脚本），
> 全量 `npm run lint`（3 errors / 34 warnings）与 `npm run typecheck`（7 errors）会红——错误全部来自未提交新文件
> （speech-queue / tts-gpt-sovits / ui-* 审计脚本），合入修复后恢复。以下为已提交代码的门禁状态：

| 门禁 | 命令 | 当前状态 |
|---|---|---|
| 单元/集成测试 | `npm test` | ✅ **924/924 通过**（892 单元 + 32 集成，90 个测试文件，mock LLM 无 key 可跑） |
| 类型检查（lib） | `npm run typecheck` | ✅ 0 错误（已提交代码） |
| 桌面端类型检查 | `npm run typecheck:desktop` | ✅ 0 错误（已提交代码；kanban-api.d.ts 74 方法一致） |
| Lint | `npm run lint` | ✅ 0 error（已提交代码；warning 若干 no-unused-vars） |
| 评测数据合法性 | `npm run bench:validate` | ✅ 6 数据集全过（脏数据 exit 1） |
| Agent 能力评测 | `npm run bench:agent` | ✅ 19/19（mock LLM，与模型无关） |
| 模型基线 | `npm run bench` | ⚠️ 最新报告为 08-15 quick 旧数据——**38 题全量基线待重跑** |
| 回归门禁 | `npm run bench:gate` | 分层门禁（硬红 exit 1） |
| 语音评测 | `npm run voice:score` / `voice:audit` | 内容完整度/音色/节奏/污染 + 末尾完整度审计 |
| 路由注册表回归 | `tests/routes-registry.test.mjs` | 139 条路由断言 + 契约覆盖率护栏（≥15 路由挂契约） |
| CI | `.github/workflows/ci.yml` | push/PR：test + validate + judge-check + quick + typecheck×2 + lint + build/check:renderer + bench:agent |
| 每周评测 | `.github/workflows/weekly-eval.yml` | 全量 Layer A + web 任务 + 消融 + 门禁 + 徽章/趋势提交 |

---

## 常见问题

**Q：每次怎么启动？**
双击 `start-kanban.bat`（桌宠主进程自动拉起并守护后台数据服务，端口 8899，**不需要单独启动 widget**）。重复双击被单实例锁拦截。

**Q：改完代码后功能没生效？**
运行中的 widget 是旧代码进程——**每次代码改动后重启桌宠**（托盘退出或 `Get-Process electron | Stop-Process -Force`）。验证新版：浏览器打开 `http://127.0.0.1:8899/api/health` 看 version 字段。

**Q：对话很慢？**
首次调用要启动 Chromium（几秒），搜索 2 站并行约 15 秒，完整"搜索+讲解"约 1 分钟属正常。简单问题直接问会快很多。

**Q：想换模型/端点？**
面板「⚙️ 设置 → LLM 服务配置」直接填；或 `.env` / `MIANSHI_PROVIDERS`（多 Provider 路由，按顺序 failover）。

**Q：怎么打安装包？**
```bash
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist    # release/ 下 NSIS 安装包 + 便携版
```

---

## 路线图

- [x] 爬取引擎 / 学习闭环 / 对话 agent / 桌宠（Live2D/气泡/全屏隐藏/自启）
- [x] 面试实录、多轮回环审计（修复 50+ 断裂点）、设置中心全可配
- [x] 语音系统：GPT-SoVITS 合成 + 评测/审计 + 训练流水线 + 交互重设计
- [x] 纵向拆分（工程质量）：139 路由插件化、agent→tools 分层、面板 5 文件、契约层（Phase 2）
- [x] 事件驱动内核（P0）：事件总线 + 自主决策 + CC 伴侣 watcher + 场景装配（P1）
- [x] 双层评测体系：数据集治理/指标/门禁/消融基线/判官校准/每周徽章
- [x] MCP 分发闭环：9 工具 + 数据自动探测 + 发布瘦身（7 deps）+ 完整分发文档
- [ ] 实时 TTS 句子级流水线（开发中：speech-queue + GPT-SoVITS 本地引擎）
- [ ] companion-poller 主进程接线（事件驱动表达 → 桌宠气泡的 1-2 行 `startCompanionPoller` 启动接线，模块已就绪；待实时 TTS 合入后一并接）
- [ ] 判官长官方差控制（金标回归 + 更多抽检）
- [ ] 评测集全量扩容（questions → 60+，渐进积累）
- [ ] P2 动作层（情绪→Live2D 动作映射）、P3 反思闭环（trace 失败模式 → 调整技能/提示词）
- [ ] Monorepo / PKCE / 受信任面板宿主（放后可选）

---

## 📦 开源说明

- **许可证**：MIT（见 [LICENSE](LICENSE)）
- **仓库不含**：本地数据（`data/`）、ASR 模型（`models/`）、`.env`（密钥）；**含**自训练声线（`assets/voice/`，开箱即用）
- **测试**：`npm test` 924 用例全绿（mock LLM，CI 零成本）；评测体系见上文
- **插件化路线**：宿主（真白）+ 插件（秋招助手）架构见 [`docs/plugin-architecture.md`](docs/plugin-architecture.md)

---

*由 Mashiro 驱动 · 真白陪你上岸*
