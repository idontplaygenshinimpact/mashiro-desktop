# 真白 · Mashiro Desktop（mashiro-desktop）

> 🎀 桌面 AI **宿主「真白」+ 第一个插件「秋招助手」**。真白是 Electron 桌宠宿主（Live2D / 语音 / 面板框架 / 设置中心），秋招助手是跑在宿主上的能力插件（面经采集 / 模拟面试 / 学习清单 / 复习卡 / 知识库 / 对话 agent / 校招闭环）。
> 2026-08 起升级为**事件驱动自主桌宠**：感知（Claude Code 会话 watcher）→ 决策（自主规则引擎）→ 装配（场景技能子集）→ 表达（气泡/语音），并落地 **API 契约层（zod）与双层 AI 评测体系（真实消融基线）**。
> 2026-09 起：**渲染层三态并行**（原生 / React / Vue 同屏可切 + dist 体积实测对比 + 两侧全 Tab 渲染护栏）、**UI 质量机器指标门禁**（8 类指标归零）、**本地 ASR 长音频分段识别**（实测 CER 4.1% → 0%）、**全量 TS 迁移完成**（实现全在 `.ts`，`.mjs` 只剩同名一行桶 → 插件协议 / Electron 入口 / `#lib/*` 调用方零改动；三条 tsc 门禁 + 每模块一提交）。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![CI](https://github.com/idontplaygenshinimpact/mashiro-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/idontplaygenshinimpact/mashiro-desktop/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/mashiro-mcp?color=cb3837&label=mashiro-mcp)](https://www.npmjs.com/package/mashiro-mcp) ![Node](https://img.shields.io/badge/Node-%3E%3D22-5fa04e) ![Tests](https://img.shields.io/badge/tests-1231%2B-8a5adc) ![Platform](https://img.shields.io/badge/Windows-10%2F11-0078d6)

---

## 架构：宿主 + 插件 + 事件驱动内核

| 层 | 内容 | 状态 |
|---|---|---|
| **真白（宿主）** | Electron 透明窗口 + Live2D 真白、点击对话（短句日语语音）、气泡提醒、全屏自动隐藏、托盘常驻、设置中心、本地 ASR 语音输入（**开机自启尚未实现**——不写注册表，见路线图） | ✅ 核心 |
| **秋招助手（插件①）** | 面经爬取 / 学习闭环 / 专项练习 / 模拟面试 / 求职闭环 / 知识库 / 对话 agent / 学习计划引擎（12 个业务路由域） | ✅ 内置（plugins/job-hunter） |
| **事件驱动内核** | 事件总线 + 自主决策（off/notify/full 三级刹车）+ CC 会话 watcher（Claude Code 伴侣）+ 场景技能装配 | ✅ P0+P1 已接线 |
| **契约层（Phase 2）** | zod 契约：**20 条路由**挂 input/output 校验（`withContract`）+ SSE 事件 union + preload/renderer 类型化（`kanban-api.d.ts` **83 个接口方法**，preload 以该类型 expose，checkJs 校验）+ 117 处硬编码收编；护栏 `tests/routes-registry.test.mjs`（路由总数 + 契约覆盖率）与 `tests/contracts.test.mjs`（400/500 语义） | ✅ |
| **双层评测（Phase 评测）** | Layer A 真实模型基线 + Layer B mock agent 机制；数据集治理（sha256）/ 成本延迟指标 / 分层回归门禁 / 消融基线 / 每周评测 workflow（机制已接线；**尚未产出真实徽章与趋势**——`<!-- EVAL_BADGE -->` 仍为空、`benchmark/trend.svg` 未入库，需带 `DEEPSEEK_API_KEY` secret 跑一周） | ✅ 机制 |
| **三态渲染层** | **8 个 Tab × 原生 / React / Vue 三态并行**（同一 preload IPC 桥 + 同一业务层零改动）；三态对比卡（dist 实测 2026-09-16：原生 367.7KB / React 244.0KB / Vue 163.3KB）；**两侧全 Tab 渲染护栏**（`tests/react-tabs.render.test.mjs` + `tests/vue-tabs.render.test.mjs`：按 tab 挂载 → 数据等价 → 特色标注 → UI 不变量 → 对称卸载） | ✅ 矩阵 8×2 满格 |
| **工程门禁** | **三条 tsc（宽松 checkJs + strict 含 lib/plugins/desktop + desktop 主进程）0 错误** + eslint **0 error 0 warning** + **1231 用例全绿**（1192 单元 + 39 集成）+ 渲染产物内容哈希新鲜度 + node:test 协议通道守卫 + UI 8 类机器指标巡检 + 本地 ASR 分段回归；**全量 TS 迁移已完成**（`lib` 122 `.ts` / `plugins` 14 `.ts` / `desktop` 11 `.ts`，实现全在 `.ts`，`.mjs` 只剩同名一行桶 → 调用方/插件协议/Electron 入口零改动；每模块一提交） | ✅ |

**秋招助手（插件①）能力一览**：

| 模块 | 作用 |
|---|---|
| **爬取引擎** | 自动逛牛客/掘金/CSDN，抓取前端 & AI Agent 面经/笔试题，AI 筛选出**具体题目**并完整讲解（结论/原理/JS实现/边界），归档 Markdown |
| **学习闭环** | 从产出提炼"优先学习清单" → 勾选完成 → 复盘出题 → 判分 → 错题自动进入**薄弱点**，下次优先学；FSRS 间隔复习 + 选择题自测 + 到期提醒 |
| **学习计划引擎** | 任意"学一段长时间内容"→ 计划实体 + 学习事件流（唯一事实源）+ 趋势聚合 + 即时反馈（与判题/复习/清单解耦的通用引擎） |
| **专项练习** | 牛客 TOP101 算法题 + **手写/算法题库 448 道**（281 道带自动判题测试，worker 沙箱隔离；答错回流薄弱点与复习卡） |
| **模拟面试** | **面试官 agent 化**（出题前可检索题库/知识库/薄弱点；**出题依据只有简历**——本地项目源码不进面试上下文，和真实面试官一样看不到你的代码）+ 五维评分 + 追问深挖（**明确说"忘了/不会"就换题**，不硬追同一题）+ **动态轮数**（薄弱点未考完自动加试）+ 复盘报告回流；**手写轮给代码编辑器**（行号 / 等宽 / Tab 缩进 / Enter 自动缩进，不再是纯文本框）；**语音答题**（🎙️ 说答案 → 本地 ASR 转写回填，长回答自动分段识别）；**继续上一场**（关面板不丢进度）+ 历史复盘回看 |
| **对话闭环** | 对话 agent（**38 个内置工具** + 13 个 MCP 工具 + 技能工具，权限分级审批）——可反哺学习清单、建复习卡、挂学习任务；**多会话**隔离；上下文压缩 + 追问语义缓存 |
| **求职闭环** | 简历 → 方向画像 → 岗位匹配/投递 → 笔试日程 → 面试邀约（邮箱自动识别）→ 全节点回流（规则引擎给"现在最该做什么"） |
| **本地知识库** | 讲解文档**段落级索引**（本机实测 147 篇 → 1478 段，追问段单独入库并加权）：**混合检索 = FTS5 trigram BM25 + bge-small-zh 向量余弦 → RRF 融合**，`bge-reranker-base` 交叉编码器精排（路由已就绪，UI 未接）；自建 20 题评测：整句短语 0% → 纯关键词 35% → **混合 55%**（`node scripts/kb-eval.mjs` 可复跑）；对话/复习/出题可引用关键词索引 |
| **Agent 投入统计** | 把多源 agent 会话（DSH / OpenCode / Codex / Claude Code）沉淀成**会话时间线 + 项目覆盖时段 + 轮次/工具调用**，驾驶舱 Tab 可看可截图——本机实测近 90 天：**764 会话 / 覆盖 256.5h / 活跃 45 天 / 14655 轮 / 15003 次工具调用 / 15 个项目** |

**事件驱动自主（P0+P1，2026-08 落地）**：

```
感知（CC 会话 jsonl watcher / 内部 hooks / 定时任务）
  → 事件总线（lib/events.ts 统一事件模型）
  → 自主决策（lib/autonomy.ts：规则驱动，off/notify/full 三级，防抖/寂静期/每日预算刹车）
  → 场景装配（lib/scenarios.ts：interview/companion/study 场景 → 技能子集，agent 只注入当前场景技能）
  → 表达（petSay 气泡 + 语音）
```

**Agent 伴侣（多源感知）**：桌宠能看到你正在用的编码 agent 在干什么（会话开始 / 工具调用 / 回复 / 结束），用气泡陪伴播报——零侵入（只读会话文件元数据，**不落正文**）。感知源覆盖四种（2026-09-11 从"只看 Claude Code"扩展而来，当时本机 `~/.claude/projects` 只有一个 7 月后不再更新的 jsonl → 感知层实战中等于没输入）：

| 源 | 数据位置 | 读取方式 |
|---|---|---|
| **DSH**（DeepSeek Harness） | `~/.dsh/sessions/**/session.jsonl.zstd` | **zstd 多帧追加流**：stat 优先，变更时**从上次偏移精确解新帧**（实测 18.9MB / 37376 帧，idle tick 只 stat ≈ 50ms） |
| OpenCode | `~/.local/share/opencode/opencode.db` | SQLite **只读 + rowid 游标**（库 1.7GB / 77624 条 part，不能全表扫） |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | 行增量（`task_started` / `agent_message` / `function_call` / `task_complete`） |
| Claude Code | `~/.claude/projects/**/*.jsonl` | 行增量（字节偏移） |

事件统一归一为 `agent:*`（`agent:session_started` / `tool_use` / `assistant_reply` / `session_finished`），气泡带来源与项目名（如"🎬 DSH 开跑了（mianshi-agent）"）。**工具调用按防打扰策略静默**（`lib/autonomy.ts` 规则返回 null），只播报开始 / 出结果 / 结束。开关：`MIANSHI_AGENT_WATCH=0` 总关，`MIANSHI_CC_WATCH` / `MIANSHI_CODEX_WATCH` / `MIANSHI_DSH_WATCH` / `MIANSHI_OPENCODE_WATCH` 分源关。

> 真实语料实测（本机）：DSH 578 个会话文件 / 0.38GB、OpenCode 266 会话、Codex 与 Claude Code 各 1 个（都停在 7 月）——**只有 DSH 是活的**，这也是"扩展多源"的直接动因。踩到并修掉两个只有真实数据才暴露的坑：① 结束判定曾把静止历史会话误报成"刚结束"（本机 `decision_ledger` 128 条假审计记录的根因，现在要求**本进程内见过增长**）；② OpenCode 首扫用 `LIMIT` 分批会把历史积压当新事件重放（现在游标直接跳到 `MAX(rowid)`）。

> **定位与局限（诚实口径，2026-09-11 自评）**：感知层信号其实很密——本机一段几小时的 DSH 会话里有 **537 次工具调用 + 324 条回复事件**，但**表达策略丢掉了其中 98% 以上**：工具调用按防打扰静默，回复类事件又被"5s 防抖 + 60s 寂静期 + 每日 20 条预算"压到每天最多 20 句，而文案是"出结果了，去看看"这种零信息量提示（你正看着屏幕，提醒你去看屏幕）。所以当前形态**是情绪价值/陪伴，不是效率工具**；真正可量化的收益在**场景技能裁剪**：全部 12 个技能 14.7KB → 当前场景只注入 1-2 个（1.8KB），**省约 88% 注入量**。要让感知层变成效率工具，方向是"会话时间线 + 项目投入统计"（项目 × 时长 × 轮次 × 工具调用）而不是气泡播报，见路线图。

> **个人数据闭环**：简历/岗位/日程/学习进度 全链路互通，自动识别邮箱面试邀约、投递状态实时同步、笔试进入统一日程表——不用手动搬数据。

### 代码地图（想读源码从这里进）

| 入口 | 文件 | 职责 / 为什么读它 |
|---|---|---|
| Electron 主进程 | `desktop/main.ts`（`main.mjs` 为一行桶） | 窗口/托盘/**70 个 IPC 通道**（`safeHandle`）/本地 ASR worker 串行与超时/语音播放/widget 守护接线；渲染层的唯一 IPC 面在 `desktop/preload.js`（类型声明 `desktop/kanban-api.d.ts`，**72 个方法**，checkJs 校验实现一致） |
| 后台数据服务 | `widget.mjs` | HTTP :8899：Bearer 鉴权/CORS/健康检查 + 路由分发（`lib/routes/router.ts`）+ **33 处定时器注册**（18 个周期 `registerInterval` + 15 个启动首跑 `registerTimer`：巡检/邮件/复习到期/岗位截止/RSS 摘要/专注收尾/RAG 增量/自检/备份/弱合并/日程提醒…，退出统一清理）+ 事件内核接线；进程级兜底日志与单实例语义在这里 |
| 路由域 | `lib/routes/core.ts`（核心域）+ `plugins/job-hunter/routes/*.ts`（12 域） | **155 条路由**按域注册；契约运行时 `lib/routes/contract.ts`：`readBodyJson`（413/400 语义）/`withContract`（input 400 VALIDATION_ERROR → output 500 SCHEMA_MISMATCH）/`createSSEPush`（`data: JSON` + 心跳 + 可选事件校验） |
| 契约层 | `lib/contracts/*.ts` | zod schema 唯一事实源（`common/chat/interview/review/study/sse/misc`），前后端共用；SSE 事件是 discriminated union |
| 对话 agent | `lib/agent.ts` + `lib/tools/{schemas,impl,impl-*,exec-tools,mcp}.ts` | **38 个内置工具**（schema / 实现 / 分发三层拆）+ 权限分级审批 + 工具结果 >8K 落盘预览（`read_tool_result` 回读）+ MCP 工具惰性接入与同名自环去重 + 上下文压缩 |
| 业务域 | `lib/interview*.ts`、`study*.ts`、`review.ts`、`quiz.ts`、`learning-plan.ts`、`jobs*.ts`、`knowledge-base.ts` | 模拟面试（出题/评分/复盘/放弃换题）、学习清单与讲解存档、FSRS 复习、题库与判题沙箱、长期学习计划引擎、岗位闭环、知识库段落检索 |
| 事件驱动内核 | `lib/events.ts` → `autonomy.ts` → `scenarios.ts` → `lib/adapters/{agent-watcher,cc-watcher}.ts` | 多源 agent 感知（DSH/OpenCode/Codex/Claude Code）→ 规则决策（off/notify/full + 防抖/寂静期/预算）→ 场景技能子集 → 表达（气泡 + 语音） |
| 存储 | `lib/db.ts` | node:sqlite（WAL 起手）+ 迁移框架（`MIGRATIONS` + `user_version`，当前 **v4**）+ **23 张业务表** + settings KV；备份/恢复在 `lib/backup.ts` |
| 渲染层 | `desktop/renderer/panel-core.js` + `panel-*.js`（原生）/ `panel-react/`、`panel-vue-review/`（Vite 子项目） | 三态渲染层：`rendererState` + `FRAMEWORK_TABS` 注册表 ⟷ 各框架 `TABS` 登记表必须一致；切换 = 动态 import 对应 bundle + 参数化挂载（`__mountReactPanel(tab, el)` / `__mountVueReview(tab, el)`）+ 偏好持久化 + 对称卸载 |
| 评测/巡检 | `benchmark/`、`scripts/bench*.mjs`、`scripts/shot-panel.mjs`、`scripts/kb-eval.mjs`、`scripts/_asr-ab.mjs` | 双层评测（真实模型 + mock agent）、UI 8 类机器指标、知识库三条基线、ASR 分段 A/B |
| MCP 分发 | `mcp-server.mjs` + `lib/data-detect.ts` | **13 个工具**暴露给外部 agent（Claude Code/DSH/Cline/Cursor/OpenCode），数据目录自动探测 + 敏感项 GATE 门控 |

### 数据与存储（本机实测规模，2026-09-14）

| 项 | 实测 |
|---|---|
| 手写/算法题库 | **448 道**，其中 **281 道**带自动判题 `test_code`（worker 沙箱隔离执行） |
| 复习卡 | 221 张（FSRS 状态机 + `card_reviews` 评分流水） |
| 学习清单 | 216 条（分组归类 / 讲解存档 / 掌握度标记） |
| 岗位库 | 233 条（方向画像匹配 / 投递状态 / 截止提醒） |
| 知识库关键词索引 | 4695 条（`knowledge_items`，FTS5 trigram；另有段落级 `knowledge_paragraphs` 混合检索 + 溯源列 confidence/evidence） |
| Agent 会话时间线 | 859 会话 / 3095 条工具事件（实时写入 + 历史回填） |
| schema | `user_version=4`；业务表 23 张 + FTS5 虚表与影子表（`sqlite_master` 共 52 项） |

### 扩展点（"想加个东西，改哪里"）

| 想加什么 | 落点 |
|---|---|
| 一个 HTTP 路由域 | `lib/routes/<域>.ts`（或插件内 `plugins/<id>/routes/<域>.ts`）→ 在 `widget.mjs` / 插件 `server.ts` 注册；用 `withContract` 挂 zod 契约（`tests/routes-registry.test.mjs` 查契约覆盖率） |
| 一个 agent 工具 | `lib/tools/schemas.ts` 加 schema → `lib/tools/impl-*.ts` 加实现 → `lib/tools/exec-tools.ts` 分发；命名与执行结果形状有测试护栏 |
| 一个技能 | 新增 `skills/<名>/SKILL.md`（+ 可选 `skill.mjs` 声明 tools/hooks），`lib/skills.ts` 支持热重载；注入子集由 `lib/scenarios.ts` 按场景裁剪（实测 12 技能 14.7KB → 场景内 1-2 个 1.8KB） |
| 一个插件 | 复制 `plugins/plugin-template/`（manifest + `server.ts`，协议即文档）；`lib/plugin-loader.ts` 负责 manifest 校验 / settings 命名空间 `plg_<id>_` / init 钩子 / 健康检查 / 失败隔离 |
| 一个面板 Tab（三态） | `panel.html` 加容器 → `panel-core.js` 的 `rendererState`+`FRAMEWORK_TABS` 登记 → `panel-react/src/tabs/*.jsx` 与 `panel-vue-review/src/tabs/*.vue` 各加组件并在各自 `TABS` 注册；护栏 = 两侧全 Tab 渲染测试（含 UI 不变量与对称卸载） |

### 业务闭环清查（8 域并行审计 + 九环判定）

> 方法：8 个域（面试 / 学习清单与计划 / 复习题库判题 / 求职校招 / 对话 agent 与工具 / 事件感知语音 / 宿主核心路由 / 知识库产出）各自**只读**审计，
> 逐功能按**九环**打勾——C1 入口可达 · C2 执行可推进 · C3 过程可感知 · C4 结果可产出 · C5 结果可持久化 · C6 历史可回溯 ·
> C7 产出可复用（数据血缘）· C8 异常可恢复 · C9 终态可清理；每条结论要求 `file:line` 证据或实测输出，专找"功能存在但不闭环"的样子货。
> 关键结论都由主审**独立复核**（含真实 Electron 探针、只读 DB 副本、反向改代码验证护栏有效性）。

**判定标准（"样子货"的十种形态）**：① 写而不读 ② 读而不写（恒空/恒默认）③ 路由/IPC 恒失败或静默 no-op ④ UI 假成功（乐观更新不回滚/固定文案/假 loading）
⑤ 空 catch 吞错 ⑥ 死分支与无效参数 ⑦ 状态机无终态或无恢复入口 ⑧ 数据血缘断点 ⑨ 三态渲染层某一态动作空实现 ⑩ 注册了却没 handler 的任务。

#### 本批已修（每处都有回归护栏，commit `e89ea72`）

| # | 断链（原状） | 断在哪一环 | 修法与护栏 |
|---|---|---|---|
| 1 | **对话流式正文全丢**：`preload.js` 把 `type:"delta"` 只发给空函数 `onChunk`，三态渲染层收不到正文增量（React/Vue 的 delta 分支不触发、原生"流式逐句语音播报"失效，只有 `done.reply` 一次性出现） | C3 | delta 转成事件回调；`tests/preload-stream-events.test.mjs`（vm 加载真实 preload + stub ipcRenderer；**已反证**：还原旧写法该用例必红） |
| 2 | **`fetch_nowcoder_user` 恒"未知工具"**：schema 声明 + 权限登记 + 实现齐备，dispatch switch 缺一臂 → 模型一调就报未知（只有 skills 直连能跑） | C2 | 补 case；工具"声明↔分发"一致性由测试抽样覆盖 |
| 3 | **>8K 工具结果读不回**：写端认 `MIANSHI_DATA_DIR`、读端硬编码仓库根 → 打包版回读恒"文件不存在" | C7 | 读写口径统一 + 兼容 `_file` 形态；`tests/tool-result-roundtrip.test.mjs`（含目录穿越仍被拒） |
| 4 | **React 复习评分坐标错 + 假成功**：按钮值 1..4 直传（后端契约 0..3）→「忘了」记成 Hard、「熟练」400，而错误体无 `ok` 字段使 `r?.ok===false` 为假 → 静默翻页、`card_reviews` 零写入 | C2/C5 | 改 0..3 + 失败判定加 `|| r?.error` |
| 5 | **「继续上一场」按钮真机不可达**：与简历框同 id `iv-resume` → `getElementById` 只拿到 textarea，按钮文案/onclick/隐藏全落到简历框上（还把按钮文案当简历发给面试官） | C8 | 按钮改 `#iv-resume-btn`；新增「panel.html 无重复 id」护栏，jsdom 用例改为断言真按钮（此前断言打在 textarea 上=**测试为假实现背书**） |
| 6 | **真题「记错题」点了抛错**：用 `window.prompt`，而 Electron 渲染进程不支持它（**实测抛 `prompt() is not supported.`**）→ 真题→错题→清单/复习卡整条不可用 | C2 | 新增页内浮层 `window.__askText`（Promise + aria-modal + Esc/遮罩取消）替换 prompt；护栏：渲染层禁用 `prompt()` 的静态断言 |
| 7 | **岗位→学习 / 岗位→面试恒 404**：面板按钮 POST 的两条 `/api/loop/*` 从未注册（后端 `deriveStudyFromJob`/`startInterviewForJob` 因此长期是孤儿函数） | C1/C7 | 按前端既有 `{ jobId }` 载荷补齐两条路由 |
| 8 | **三态口径不一致**：React/Vue 校招 Tab 状态筛选 `none` vs 后端枚举 `new` → 筛选恒空 | C2 | 两侧统一为 `new` |

#### 第二批已修（commit `f71baab`）

| # | 断链（原状） | 断在哪一环 | 修法与护栏 |
|---|---|---|---|
| 9 | **巡检设置区从不回填**：`GET /api/patrol-config` 不返回 `ok`，而面板是 `if (r?.ok) { 回填开关/间隔/预算 }` → 开关恒为 HTML 默认、间隔/预算框恒空（占位假值 100000），用户一保存就把假值写成真实 token 预算 | C2/C5 | 补 `ok:true`；`tests/patrol-config-route.test.mjs` |
| 10 | **三态框架互切重叠渲染**：框架→框架直接互切时只隐藏了原生容器，另一个框架容器既可见又保持挂载（两套 UI 重叠、事件双绑）；卸载失败被空 catch 吞成"可见但空白"的假成功 | C2 | 互切时先隐藏并卸载对方框架 + 卸载失败改 `console.warn`（可诊断）；**此项目前无 jsdom 护栏（待补）** |
| 11 | **爬取 TLS 全灭 + 零产出仍报成功**：`newContext` 未开 `ignoreHTTPSErrors`（本机 MITM 证书 → 所有起始页 `ERR_CERT_AUTHORITY_INVALID`）；`discover.mjs` 零产出静默 return、退出时把进度覆盖成 idle → 面板永远"暂无任务" | C3/C4/C8 | 抓取 context 全部开证书容错（SSRF 内网拦截不受影响）；零产出写 `status=error` + `exitCode=1`，失败/中断不再清成 idle，SIGINT 写"已被中断" |
| 12 | **复习两处无终态**：重练队列只看"窗口内出现过答错"、不看最近一次 → 错→错→对 后永久滞留；错题本 `AND is_first=0` 把首刷答错排除在计数外 → 门槛实为"错 ≥3 次"，生产库无卡达标 → 面板恒空 | C7 | 队列按"最近一次仍答错"判定；错题本按"答错总次数 ≥2"判定；`tests/review-terminal-states.test.mjs` |

#### 第三批已修（commit `b4d3968`）

| # | 断链（原状） | 断在哪一环 | 修法与护栏 |
|---|---|---|---|
| 13 | **「已掌握」是不可达终态**：写侧 `matchKp` 未命中知识树时用「归一化 topic 自身」当 key 落 `kp_mastery`，读侧却用 `getMastery()`（只列**树内**的点）建 map → 树外条目永远 `mastered=false`（实测 `kp_mastery` 43 行里 `score>=80` 为 **0 行**） | C4/C7 | 新增 `getMasteryLookup()`（落盘掌握表快照：树内 id 与动态 key 同一 key 空间）供读侧使用；`recordKp` 入口加**形态守卫**（整句题干/问句直接拒收，防 `请继续深入讲讲「…」` 这类递归题干键继续入库）；`tests/mastery-key-space.test.mjs` |
| 14 | **清单 89% 条目恒在「待复习」**：到期口径把 `fsrs_due=0`（**从未复习**的新卡）按"创建满 1 天"也算到期 → 221 张卡里 174 张新卡全部算到期，「已学/已掌握」两组永不出现 | C3 | 到期只认 `fsrs_due > 0 && <= now`；新卡归「待学/学习中」（每日队列仍按 FSRS 缓冲调度，不漏复习）；`tests/study-due-semantics.test.mjs` |

> **真实数据基线（只读副本实测）**：清单「待复习」条目 **192/216（89%）→ 45/216（21%）**，其余条目回到由"已学/讲解存档"决定的分组；掌握度侧 `kp_mastery` 从此可被正确读回（此前 `score≥80` 恒为 0 行）。



#### 第四批已修（commit `945e6ac`）

| # | 断链（原状） | 断在哪一环 | 修法与护栏 |
|---|---|---|---|
| 15 | **渲染层 IPC 声明漂移**：`preload.js` 暴露 81 个键、`kanban-api.d.ts` 只声明 72 个 —— 漏了 `reviewFeedback`/`reviewRetry`（Vue 复习面板在用）、`ttsSynth`/`ttsPlayFile`/`stopSpeak`（实时语音两阶段）、`openReactPanel`/`openVuePanel`（三态独立窗口）；checkJs 只能校验"已声明项的实现是否匹配"，漏声明永远发现不了 | C4 契约 | 补齐 7 条声明 + `tests/ipc-declaration.test.mjs`（解析 preload 暴露面 vs 声明面，缺一即红——**首个能发现"漏声明"的护栏**） |
| 16 | **爬取产出写完没人读**：`scanNewestFiles` 只扫一层 `output/<日期>/*.md`，而爬取把讲解写在 `output/<日期>_discover/讲解/**.md` → 这些文件永远进不了「最新产出/今日推荐」 | C7 | 改为递归扫描（深度 ≤3、跳过学习存档与 `00_` 索引、`dir` 保留相对子路径）；目录判定走 `statSync().isDirectory`（真实 fs 生效、假 fs 保持单测隔离） |

#### 第五批已修（commit `d07498f` / `7407d12` / `72e04c7` / `a35809e` / `db58fa7`）

| # | 断链（原状） | 断在哪一环 | 修法与护栏 |
|---|---|---|---|
| 17 | **判题结果不回流（练与学是断的）**：`/api/challenges/run` 只埋点不落状态——通过不写 `challenges.done`（生产库 **done 恒 0/448**）、答错不写 `wrong_count`/薄弱点/复习卡；`mark-wrong`/`mark-done` 又是 `ok: r?.ok ?? true` + 固定文案 → 题目不存在也报"已记录答错，自动加入复习卡"（面板据此显示成功，实际零写入） | C4/C5 | 判题通过 → `markChallengeDone`（done + 学习进度回流）、失败 → `markChallengeWrong`（wrong_count+1 + 薄弱点 + 自动建 FSRS 卡），响应带 `reflow` 让面板如实展示；两条 mark 路由题目不存在 → 404 + `ok:false`；题库卡 topic 前缀 `手写题·` 与薄弱点 key 不一致导致"复习答对也清不掉"→ 双候选清理；`tests/challenge-reflow.test.mjs`（6 项，**旧代码下 5 项红**） |
| 18 | **爬取没有停止入口 + 互斥闸门形同虚设**：`createCrawlMutex` 只护 `spawn` 一瞬（discover 要跑几分钟）→ `isRunning()` 几乎恒 false，`/api/run-discover` 的 409「已有爬取任务运行中」与巡检「爬取中则跳过」全部失效（可并发拉起多个 chromium）；`progress.json` 与真实进程脱节（进程被强杀就永远停在 `running`，面板一直显示"爬取中"） | C1/C8/C9 | 互斥判定绑到子进程**真实存活期**（`track`/`exit` 自动释放 + `release` 兜底）；新增 `POST /api/stop-discover`（Windows 走 `taskkill /T /F` 杀**进程树**，本机实测：孙进程 detached 启动时只 kill 直系会留下孤儿，杀树后父与孙全消失；终态由停止方写，因为 `/F` 强杀不会执行子进程的 exit handler）；`/api/widget-data` 增加 `crawlRunning`（三态按钮态与轮询不再只信 progress.json）；三态都有「⏹ 停止爬取」；`tests/crawl-stop.test.mjs`（8 项，旧代码下 5 项红） |
| 19 | **`schedule_events` 无删除终态**：写入两条（邮箱邀约识别 / 岗位笔试同步）、读取两条（未来日程 / 提醒窗口），**没有任何删除路径**——解析错或已取消的邀约每次提醒都再弹一遍；"时间待定"（`interview_at` 为空）的邀约永远显示（真实库现 4 行、时间待定 0 行，该形态由测试构造复现） | C9 | `mail.deleteEvent` + `POST /api/schedule/delete`（成功 200 / 不存在 404 / 缺 id 400）+ 原生日程每条「🗑 删除」（confirm 二次确认、失败如实提示） |
| 20 | **`job_posts` 无归档终态**：只有 new/ready/ready_bishi/done，自动搜集进来的岗位（**只读副本实测 247 行全 `status='new'`**）没有任何办法清掉，「未处理」越堆越多、推荐被垃圾岗位占位 | C9 | 新增 `archived`（**软删除**：行保留作为入库去重依据，否则下次搜集又加回来）；归档不记 `applied_at`（否则统计冒出幽灵投递）；默认列表/推荐/RAG 索引都排除归档，显式 `status:"archived"` 可查可恢复；归档行收起「学考点/按岗面试」（那两条按 id 查岗位已排除归档，点了必 404）；三态入口 + `getJobStats` 单列 archived |
| 21 | **持久化调度层完全不可达**：`scheduler` 每分钟 `checkDue`、三个 job_type 执行器齐备，种子任务却恒 `enabled:false`，而**没有任何路由/UI 能列出或启用它们**（注册了却没入口） | C1 | `scheduler.runJob`（立即运行一次，与 `checkDue` 共用 `runOne` → 同失败计数/心跳/自动禁用语义）+ `GET /api/scheduled-jobs`、`POST /api/scheduled-jobs/{toggle,run}`（未注入/无执行器/任务不存在都不报成功）+ preload/main/`kanban-api.d.ts` 三处 IPC + 设置区「⏱️ 定时任务」区块；`widget.mjs` 用提前声明的 `schedulerRef` 注入（scheduler 在文件后段才创建，规避 TDZ） |
| 22 | **`/api/review/add` 丢 `priority`**：`addCard` 支持 必会/进阶/拓展（调度按优先级排序），路由层却把它丢掉 → 一律落"拓展"，优先级调度静默失效 | C4 | 契约补 `priority`（非法值 400，不静默降级）；写库失败改为直接上报真实原因（原先靠输出契约兜底报 `SCHEMA_MISMATCH`，不是假成功但错误码误导）；`tests/review-terminal-states.test.mjs` +2、`tests/scheduler.test.mjs` +3、`tests/terminal-states.test.mjs`（10 项，旧代码下 8 项红） |
| 23 | **面试历史"读得到、删不掉"**：每场复盘的复盘写进 `interview_history`、`GET /api/interview/history` 也读得到，但**没有删除函数、没有路由、UI 没有入口**——错误/测试产生的复盘永远留在历史里 | C9 | `memory.deleteInterviewHistory(id)`（按主键删；**DB 与内存镜像同步删**——只删 DB 会让同进程继续读到"鬼影"；镜像条目补主键，否则 UI 的 id 与镜像对不上、删除空转）+ `POST /api/interview/history/delete`（200 / 404 / 缺参 400）+ 三态入口（原生两处、React、Vue，一律 `confirm` 二次确认、失败如实提示）；`tests/interview-history-delete.test.mjs`（4 项，改坏路由后 3 项必红） |
| 24 | **Vue 面试无语音作答**（三态能力不对齐，第 ⑨ 种样子货）：React 版早有「麦克风采集 → `speechToText` → 回填作答」整条链路，Vue 版一格都没有 | C2/C9 | 照抄 React 版契约补齐：AudioWorklet 16k 单声道采集 + 录音状态机 + 停止/取消 + **卸载时释放麦克风流**（不泄漏）+ 空转写/失败可见提示；worklet 路径判据与 React 一致（内嵌/独立窗口）；`tests/vue-interview-speech.test.mjs`（4 项，**已独立反证**：改名 IPC 调用后必红） |

#### 待修（已定位到 `file:line`，按严重度排序；完整报告见 `%TEMP%\mashiro-audit\{A..H}-*.md`）

- **P0 巡检三键"读而不写"**：`lib/patrol.ts` 读 `patrol_enabled/interval_min/avoid_peak`，写点只在面板路由；真实库 30 个 settings 键里没有这三个 —— 面板"默认态与后端相反"这一症状已由第二批 #9 消解（`GET /api/patrol-config` 带 `ok` 后按后端真实态回填）；仅剩"用户不动就不落盘"（行为等价，不再算断链）
- **P1** 爬取/产出与岗位库两条独立管线；`decision_ledger` 写而不读（无读函数）；自主播报的语音 scene 不存在（"看得见字，听不见音"，`lines.json` 无 `agent-*`）；场景装配冷启动不装配且 UI 不可见；`tool_results/` 启动时清 >7 天（无运行期回收）；审批按工具名放行（无 args 维度）；三套「掌握」互不同步（`kp_mastery` / `mastered_points` / `fsrs≥21`）；备份只还原主库（`study_notes`/`schedule_events` 不恢复）；167/448 题 `test_code` 为空导致判题恒失败（`scripts/gen-challenge-tests.mjs` 可补，需写真实库）；三态互切与爬取失败语义的 jsdom 护栏待补；面试历史镜像只留最近 **20** 条（`saveInterviewHistory` 的 `.slice(-20)`）→ 面板只能看到/删除最近 20 场，更早记录仍在 DB 累积且 UI 无入口触达（删除终态对"可见"记录已完整）



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
| 本地知识库 | 设置 → 本地知识库 | **默认开**（`lib/rag.ts ragEnabled()` 无记录即视为开）；对话/复习/出题引用的是 **FTS5 关键词索引**（零模型零内存）；知识库 Tab 的段落检索是**混合检索**（BM25 + 向量 + RRF），向量模型首次检索时加载（bge-small-zh 量化版，国内需配镜像，见下行） |
| 向量模型下载镜像 | 环境变量 `MIANSHI_HF_ENDPOINT`（或标准 `HF_ENDPOINT`） | transformers.js 默认打 huggingface.co（国内 `fetch failed` → 向量腿静默退化为纯关键词）；配 `https://hf-mirror.com/` 实测可用（1478 段向量 52s 补齐）；缓存落在 `<data>/models/transformers` |
| 招聘平台（BOSS） | 校招 Tab → 平台账号 | 启用/登录态/投递设置/招呼语 |
| 自主模式（事件驱动） | 环境变量 `MIANSHI_AUTONOMY` | off / notify（默认）/ full 三级；`MIANSHI_AUTONOMY_BUDGET` 每日表达上限 |

> 兜底：`.env` 仍生效（`DEEPSEEK_API_KEY`/`MIANSHI_MODEL`/`MIANSHI_PROVIDERS`/`MIANSHI_HF_ENDPOINT` 等），面板配置优先。

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

13 个工具（数据工具只读；`generate_project_guide` / `generate_dev_history_guide` 写入 `output/`）：

| 工具 | 能力 |
|---|---|
| `search_posts` | 搜索牛客/掘金/CSDN 前端 & AI Agent 面经帖 |
| `solve_question` | 完整讲解面试题（结论/原理/JS 实现/边界） |
| `get_study_plan` / `get_study_progress` | 学习清单与进度 |
| `start_interview` | 模拟面试官（项目拷打/八股穿插/手写收尾） |
| `get_personal_profile` / `get_jobs_status` / `get_schedule_events` / `get_project_archives` | 个人数据环境（简历/岗位/日程/项目源码档案） |
| `generate_project_guide` / `read_project_file` | 项目面试讲解指南（基于真实源码 7 段生成：分层读取 + subagent 并行深读 + 覆盖范围透明）；可移植 skill 包见 `project-guide-skill/` |
| `read_dev_history` / `generate_dev_history_guide` | 开发历史（git 时间线 + opencode/DSH 会话，只读三源）+ 开发历史面试文档（5 段：时间线/关键决策/技术拷打点/八股/踩坑） |
| `get_personal_profile` 等 5 件套 | 个人数据环境（简历/岗位/日程/学习进度/项目源码档案；敏感项支持 `MIANSHI_MCP_GATE=on` 门控 + 读取审计） |

**诚实两档**：数据工具零配置可用（空库优雅返回）；`solve_question`/`start_interview`/`generate_project_guide` 需 LLM Key（无 key 快速报错并给配置提示）。完整分发文档（工具清单/各客户端配置/使用示例/FAQ/数据权限）：**[docs/mcp.md](docs/mcp.md)**。

### 接入 DeepSeek Harness（DSH）

`dsh-mcp-client` 实例接入后，agent 获得 `mcp__mashiro__*` 工具（search_posts / solve_question / get_study_plan / start_interview / 个人数据 5 件套），可让 DSH 直接"搜面经 → 讲解 → 建清单 → 模拟面试"。

---

## 使用方式

### 1. 桌宠（推荐日常使用）

- **点击真白** → 短句应答（摸头/戳脸等部位人设）；**空闲 5 分钟** → 长句独白（GPT-SoVITS 真白声线）
- **面板**（**9 个 Tab**：🎤 面试 / 🔁 复习 / 📋 学习清单 / 💬 对话 / 🔍 爬取 / 🏢 校招 / 📊 驾驶舱 / 🧠 知识库 + 由右上角 ⚙️ 进入的设置 Tab）——**8 个业务 Tab** 右上角可切换**原生 / React / Vue 三态**渲染层（含包体积对比卡，数据来自 dist 实测）；⚙️ 设置 Tab 仅原生实现（不参与三态切换）
- **气泡** → 爬取进度 / 新产出 / 学习提醒 / **CC 伴侣播报**（事件驱动）
- **全屏（B站视频/游戏）** → 自动隐藏；**托盘** → 右键菜单（面板/换肤/音乐/爬取/邮箱/巡检/退出）
- **形象切换** → 真白·旅行装/水手服/私服 + 时雨，点击即换、重启记忆
- **语音输入** → 面板 🎤 说话自动转文字（本地 sherpa-onnx 离线识别，零 API key）；**长回答自动分段识别**（能量谷切段 ≤14s 逐段识别，修复"多句+思考停顿"整段送模型导致的跨句串位）+ 技术术语/同音词纠错（实测同一段 90s 音频 CER 4.1% → 0%、6.7s → 4.8s）

### 2. 预设技能（对话直接触发，12 个）

| 技能 | 触发方式 | 能力 |
|---|---|---|
| 🧾 **frontend-cheatsheet** | "讲一下事件循环/闭包/浏览器缓存…" | 八股讲解按高频考点清单覆盖追问点 |
| 🔥 **interview-warmup** | "明天面试怎么准备/面试前热身" | 5 分钟流程：摸底→搜面经→演练→收尾回流 |
| ⚖️ **tech-compare** | "React 和 Vue 哪个好" | 统一对比框架（结论→差异→本质→选型） |
| 📄 **resume-coach** | "帮我看看简历"（贴简历） | 结构化优化：亮点/风险/量化改进/面试预设问题 |
| 🏢 **company-intel** | "字节面什么" | 目标公司面经情报（TOP 考点+真题线索） |
| 🐙 **github-repo** | "React 仓库多火" | GitHub 仓库信息（stars/语言/更新时间） |
| 📖 **project-guide** | "生成 XX 项目的面试讲解指南/我的项目怎么讲" | 基于真实源码生成 7 段讲解指南（定位/选型/架构/亮点/问题清单/防御/简历 bullet）——分层读取 + subagent 并行深读 + 覆盖范围透明，多轮反馈可细化；可移植 skill 包（`project-guide-skill/`，纯提示词）可加载到任意 agent（Claude Code/DSH/Codex），MCP 桥接见上表 |
| 🎯 **interview-prep** | "准备 XX 项目的面试/生成面试准备文档" | 基于真实源码生成完整面试准备文档：源码要点 + **全部八股（详细可背）** + 全覆盖拷打问答 |
| 🗂️ **dev-history-guide** | "生成开发历史面试文档/这个项目开发过程怎么讲" | 基于 **git 时间线 + opencode/DSH 会话**生成开发历史讲解文档（时间线/关键决策/技术演进/可讲亮点） |
| 📝 **project-doc** | "给项目补学习文档" | 项目学习文档生成（分步生成 + 源码外信息注入 + 多轮打磨 + 覆盖校验 ≥95%，subagent 并行） |
| 📊 **project-eval** | "评估一下这个项目" | 项目全面评估报告（8 维度评估 + 问题清单 + Top 5 改进；分步评估 + 打磨循环） |
| 🐮 **nowcoder-surf** | "逛逛牛客/找找面经线索" | 自主逛牛客：围绕目标做价值判断 + 线索扩展 + 逛完判定 + 汇报（不是固定 URL 爬虫） |

> 技能即插即用：新增 `skills/<名>/` 目录即可（`lib/skills.ts` 的 `reloadSkills` 支持热重载，HTTP 管理路由待补）；**场景装配**（P1）下 agent 只注入当前场景技能子集（面试中/CC 陪伴/学习），省 token、降幻觉面。

### 3. 命令行爬取 / 4. 学习闭环 / 5. 专注（番茄钟 + 陪伴）/ 6. 语音交互 / 7. 本地知识库

沿用既有能力（详见 git 历史版本与本仓库 `docs/`）：

- **命令行**：`node discover.mjs`（AI 逛网模式）/ `node run.mjs`（手动处理 links.txt），产出归档 `output/<日期>_discover/`
- **学习闭环**：✨生成清单 → 勾选 → 📝复盘判分 → 错题回流薄弱点/复习卡；**学习计划引擎**：对话说"建一个 XX 计划"即创建，做题/复习/面试自动归入并按趋势给即时反馈
- **专注**：25/45 分钟番茄钟 + 黑名单分心监督（标题/进程/正则）+ 目标回流学习进度
- **语音**：112 个短句 + 26 个长句日语声线资产；`voice:synth/score/audit/train` 全套合成-评测-训练流水线（实时 TTS 句子级流水线开发中）
- **知识库**：对话/复习/出题命中 **FTS5 关键词索引**（设置里默认开，零模型）；知识库 Tab 走**段落级混合检索**（BM25 + 向量 → RRF 融合 + 追问段加权，向量缺失时后台自动补齐）；`node scripts/kb-eval.mjs` 可对比「短语 / 词项 / 混合」三条基线的 top5 命中率

---

## 项目结构

```
mashiro-desktop/                    # 宿主 + 插件（插件化架构，见 docs/plugin-architecture.md）
├── desktop/                        # ── 真白宿主：桌宠（Electron）──
│   ├── main.ts                     # 主进程：窗口/托盘/70 个 IPC 通道/widget 守护/本地 ASR/语音播放（main.mjs 仅剩一行桶）
│   ├── kanban-api.d.ts             # 渲染层 API 类型声明（83 个接口方法，preload 以该类型 expose，checkJs 校验）
│   ├── preload.js                  # IPC 桥接（72 个类型化方法 + SSE 流封装 + 事件订阅）
│   ├── lib/                        # 主进程模块（widget-server.ts 守护 / window-state / restart / companion-poller）
│   ├── voice-pack.ts / tts-edge.ts / foreground.ts   # 日语语音包播放（预设匹配 + ack 兜底）/ 前台窗口检测（koffi FFI）
│   └── renderer/                   # 面板 9 Tab：8 个业务 Tab（原生/React/Vue 三态）+ ⚙️ 设置（仅原生）
├── plugins/                        # ── 插件目录 ──
│   ├── job-hunter/                 # 插件①：秋招助手（manifest + server.ts + 12 业务路由域）
│   └── plugin-template/            # 示例插件模板（协议即文档：settings/health/init/panel 四个注册点）
├── lib/                            # ── 共享业务库（122 个 .ts 实现 + 66 个 .mjs 桶，单一数据源）──
│   ├── agent.ts + tools/           # 对话 agent（38 内置工具，权限分级审批；tools/ 按 schema/实现/分发三层拆）
│   ├── interview*.ts / study*.ts / review.ts / quiz.ts / learning-plan.ts / memory.ts
│   ├── events.ts / autonomy.ts / scenarios.ts / hooks.ts   # 事件驱动内核（P0+P1）
│   ├── adapters/agent-watcher.ts + cc-watcher.ts           # 多源 agent 会话感知（DSH/OpenCode/Codex/CC）
│   ├── contracts/                  # Phase 2 契约层（zod schema，前后端类型唯一事实源）
│   ├── routes/                     # 路由域（core + contract 契约运行时 + router 注册表）
│   ├── eval-cost.ts / eval-summary.ts / eval-scoring.ts    # 评测指标层
│   ├── data-detect.ts              # 桌宠数据目录自动探测（MCP 装包即连）
│   ├── speech.ts                   # 本地 ASR（sherpa-onnx + whisper 兜底；长音频分段 + 术语纠错）
│   └── db.ts                       # node:sqlite 主存储（WAL，23 张业务表 + settings KV + 迁移 user_version=v4）
├── widget.mjs                      # 后台数据服务（HTTP :8899）：155 条路由（core + 12 插件域，含契约覆盖率护栏）
│                                   #   + 33 处定时器注册（巡检/邮件/复习到期/岗位截止/RSS/专注/RAG 增量/自检/备份…）+ 事件内核接线
├── mcp-server.mjs                  # MCP Server（13 工具 → 外部 agent）
├── skills/                         # 12 个技能（SKILL.md 声明 + 可选 skill.mjs 可编程）
├── project-guide-skill/            # 可移植 skill 包（纯提示词，任意 agent 加载即用）
├── benchmark/                      # 双层评测数据集（questions 38 / classify 16 / detect 12 / judge-gold 20 / static 12 / web-tasks 19；Layer B mock agent 场景 19）+ 报告 + 趋势
├── scripts/                        # 评测/导入/语音/发布/巡检工具（76 个 .mjs + 语音训练 26 个 Python：含 shot-panel UI 审计、
│                                   #   _asr-ab ASR 回归、kb-eval 检索三条基线对比、gen-renderer-sizes 体积实测、web-task-bench 端到端任务）
├── tests/                          # 1231 用例（1192 单元 + 39 集成，135 个测试文件，mock LLM 无 key 可跑）
├── docs/                           # 公开文档（mcp 分发/CC 伴侣/插件架构/技术方案；内部评估审计文档本地留存不上仓库）
├── assets/voice/                   # 自训练声线（112 短句 + 26 长句 + nanami 声线）
└── .github/workflows/              # ci.yml（全量门禁）+ weekly-eval.yml（每周评测）+ release.yml（双源发布）
```

### 渲染层三态并行（原生 / React / Vue —— 8 Tab × 2 框架矩阵满格）

| 渲染层 | 技术 | 覆盖 Tab | dist 实测 | 选型依据 |
|---|---|---|---|---|
| 原生 | 原生 JS + **esbuild** 单入口 | 全部 9 Tab（对照基线；设置 Tab 只有原生） | **367.7KB**（gzip 112.3KB / 6 文件） | file:// 加载不需 dev server/HMR；零依赖启动快 |
| React 版 | **Vite 子项目**（`panel-react/`，vite 7） | 8/8（面试·驾驶舱·知识库·学习·爬取·校招·对话·复习） | **244.0KB**（gzip 77.0KB，含 React 运行时） | 交互密集：**useReducer Phase 状态机** + useMemo 派生缓存 + useDeferredValue 搜索 |
| Vue 版 | **Vite 子项目**（`panel-vue-review/`，vite 6） | 8/8（同上） | **163.3KB**（gzip 58.6KB，含 Vue 运行时） | 数据可视化：**响应式 computed 曲线缓存** + watch 动画 + Transition 切卡 |

三态共用**同一 preload IPC 桥 + 同一业务层**（`lib/interview*.ts`/`lib/review.ts` **零改动**）——**渲染层可替换性有代码证据**：功能等价证明可替换，同时各框架秀招牌特性（React useReducer/并发渲染、Vue 响应式/Transition）——"渲染层选型"从口号变成可对比的实现 + 实测包体积（`npm run gen:sizes` 从 dist 生成，`tests/renderer-sizes.test.mjs` 防数据过期）。

> 一致性由测试守护：`panel-core.js` 的 `FRAMEWORK_TABS` 注册表 ⟷ 各框架 `TABS` 登记表必须一致（`tests/react-panel.test.mjs`）；**两侧全 Tab 渲染护栏**——`tests/react-tabs.render.test.mjs` 与 `tests/vue-tabs.render.test.mjs` 用真实构建产物 + mock IPC/fetch，逐 Tab 断言"按 tab 分发 → 数据同源 → 框架特色标注 → UI 不变量（无深色内联样式/可点击元素有可访问名）→ 对称卸载"；未登记 Tab 一律抛错（不允许静默挂错面板）。

---

## 关键技术点

- **事件驱动自主内核**：`events.ts`（统一事件模型 + 表达队列）→ `autonomy.ts`（规则决策，三级模式 off/notify/full，防抖 5s/寂静期 60s/每日预算 20 条，审计 decision_ledger；`cc:tool_use` 按防打扰静默）→ `scenarios.ts`（事件→技能子集，scene.json 持久化）→ `adapters/agent-watcher.ts` + `cc-watcher.ts`（四源会话感知：jsonl 行增量 / DSH zstd 多帧精确增量 / OpenCode SQLite rowid 游标；只读元数据不落正文）
- **API 契约层（Phase 2）**：`lib/contracts/*.ts` zod schema 唯一事实源——`lib/routes/contract.ts` 的 withContract 包装器（input 校验 400 VALIDATION_ERROR / output 校验 500 SCHEMA_MISMATCH）、SSE 事件 discriminated union（统一 `createSSEPush`）、preload 类型化（`kanban-api.d.ts` 72 个接口方法 + checkJs 校验）、117 处硬编码 8899 收编为单一 `API_BASE`
- **双层评测（Phase 评测）**：Layer A 真实模型（客观代码验证 + LLM-as-Judge 双评 + CRAG 事实判官，数据集 sha256 治理，`eval_summary.csv` 19 列回归底座）+ Layer B mock agent（pass³，故障注入）；分层门禁（硬红/黄牌）；**消融基线**（裸 prompt vs 全链路，实测 Δ judge +7pt / cover +5pt / CRAG -17pt，含判官长文校准）
- **Live2D 渲染**：pixi-live2d-display + Cubism2（`sharedTicker: true` 必须）；透明窗口 WebGL（canvas `transparent` + `showInactive`）
- **全屏检测**：koffi FFI 直调 `GetForegroundWindow`（毫秒级，替代慢速 PowerShell）；`lib/adapters/foreground.ts`（`desktop/foreground.ts`）同时取前台窗口标题 + 进程名供专注监督
- **LLM 客户端**：统一 `lib/llm.ts`——failover 主+备双端点 + 3 次重试 + 空响应翻倍重试 + SSE；多 Provider 路由（`MIANSHI_PROVIDERS`）；上下文压缩（token 估算触发，70%+ 缩减实测）；`withLLMTimeout` 空闲超时（流式输出中不超时，挂起才断）
- **记忆防污染**：origin 溯源（owner/agent/untrusted）——爬虫提炼的伪知识点不注入 prompt
- **Skills 插件 + 场景装配**：SKILL.md 声明式 + skill.mjs 可编程（tools/hooks/权限），`skill__<skill>__<tool>` 命名空间，`lib/skills.ts` 热重载；P1 场景激活子集（agent 只注入当前场景技能）
- **可观测性**：`trace_llm`/`trace_tools` 每次调用记录 token/耗时/成败；面板运行监控实时可见
- **定时任务与调度**：`widget.mjs` 的 33 处 `registerTimer/registerInterval`（18 周期 + 15 启动首跑；进程内、显式管理、退出统一清理）**+** `lib/scheduler.ts` 的持久化调度（`scheduled_jobs` 表 + `schedule_spec` 解析 + 失败自动停用）——scheduler 是 ADDITIVE 层，种子任务默认禁用，不与既有定时器双重触发
- **渲染层三态并行**：同一业务层 + 同一 IPC 桥上的三套实现（原生 / React / Vue），覆盖 8 个 Tab×2 框架；`gen:sizes` 从 dist 实测包体积（原生 367.7KB / React 244.0KB / Vue 163.3KB），注册表一致性 + 两侧全 Tab 渲染测试 + 体积数据新鲜度三重护栏
- **语音识别长音频分段**：实测定位"多句 + 思考停顿的长音频整段送离线 paraformer → 注意力跨句错配（把后句的词串进前句、整句重复）"；修法是 `segmentVoice` 能量谷切段（静音 ≥250ms 视为句界，合并 ≤14s）+ 逐段识别拼接，并补齐术语/同音词纠错表（技术栈是/有限状态机/JD/FSM…）——同一段 90s 音频 **CER 4.1% → 0%、耗时 6.7s → 4.8s**（`scripts/_asr-ab.mjs <wav> <gt.txt>` 可复跑，需自备样本与真值；另一段样本的早期记录见 `lib/speech.ts` 注释：5.5% → 4.5%、6.8s → 3.3s——**数字随录音/切分不同，不要跨样本比较**）；`MIANSHI_KEEP_ASR_AUDIO=1` 可落盘真实录音样本，便于按真实嗓音继续调
- **本地知识库混合检索（2026-09-11 补齐）**：`lib/knowledge-base.ts` —— 讲解文档按标题/💬 追问切段（追问=用户亲手问的缺口，检索加权）→ `knowledge_paragraphs` + FTS5 trigram；检索 = BM25（含 2 字词 LIKE 兜底）+ bge-small-zh 向量余弦 → **RRF 融合**（k=60，分数不可比只看排名）→ `bge-reranker-base` 交叉编码器精排（粗排 top10 → top5，路由 `/api/knowledge/paragraphs/search-reranked` 已就绪但**前端未接**）。踩过的三个坑都固化成修复：① 向量列**只读不写**（索引期从不向量化 → 向量腿一直是空的，实测 35% → 补齐后 55%）；② transformers.js 默认远端 huggingface.co（国内 `fetch failed` 被 catch 吞掉 → 静默退化，现支持 `MIANSHI_HF_ENDPOINT` 镜像）；③ 缓存目录默认是 cwd 相对 `.cache`（会在仓库根留垃圾 → 固定到 `<data>/models/transformers`）
- **Agent 会话时间线（"把感知信号沉淀成数据"，2026-09-11）**：`lib/agent-timeline.ts` 两张表——`agent_sessions`（会话汇总：source/project/起止/轮次/工具数）+ `agent_tool_events`（工具明细，支持高频工具与按天分布）；写入两条路径：**实时**（事件总线回调）+ **历史回填**（OpenCode 走 SQL 聚合 266 会话；DSH 用「会话头 createdAt + 文件 mtime」近似并标 `partial`，**不逐帧解压** 18.9MB×578 个）。**指标口径踩了三处坑才修对**：① 会话区间大量重叠，直接求和得到 6128h（≈256 天）→ 改**区间并集**；② 区间跨统计窗口/跨自然日，出现"单日 81.2h"这种不可能值 → 按窗口与自然日**裁剪**；③ OpenCode 的会话 `title` 是"项目浏览/问候"这类临时标题，会把项目统计打散 → 按 `directory` 目录名归组。展示在「📊 驾驶舱」Tab；UI 明确标注"覆盖时段 = 存在活跃会话的时段并集（并行 agent 会叠加到接近全天），**不是工作时长**"
- **UI 质量机器指标巡检**：`scripts/shot-panel.mjs`（真实 Chromium，非 jsdom）量 8 类问题指标——内联深色样式 / 正文 <11px / 可点击元素缺可访问名 / 图片缺 alt / 横向溢出 / **WCAG 对比度**（透明度与渐变感知，避免"紫字配紫底"假阳性）/ 点击目标 <24px / 横向裁切；另记节点数与 scrollHeight 作"空白假绿"护栏。交互类缺陷同样固化成断言（如"固定浮层滚轮死区"→ `scripts/_verify-review-scroll.mjs` 10/10）
- **全量 TS 迁移（已完成，一模块一提交）**：叶子优先 + **桶化**（每个迁移后的模块都保留一行 `export *` 的 `.mjs` 桶 → 按路径加载的调用方零改动）；**三条 tsc 门禁**（宽松 checkJs 覆盖 `.mjs` + strict 覆盖 `lib/**`/`plugins/**`/`desktop/**` 的 `.ts` + `tsconfig.desktop.json` 覆盖主进程/preload/api-client）。覆盖顺序：核心业务 → 编排层 → 服务入口（契约/路由/工具/适配器/平台）→ 插件 12 个路由域 + 模板 → 桌面（widget-server / tts-edge / foreground / voice-pack / main / speech-queue）。
  迁移不只是"加类型"，它把**此前被隐式 any 掩盖的真缺陷**顶了出来，逐个修掉并补了回归护栏：① `/api/review/feedback` 与 `/api/review/retry` 把 JSON-Schema 形状的普通对象当 zod schema 传给 `withContract` → 运行期 `output.safeParse is not a function` → **两条路由恒 500**（`tests/review-routes.test.mjs` 护栏）；② `POST /api/settings/reminders` 把 `readBody` 的**原始字符串**当对象用（`hasOwnProperty.call(字符串, key)` 恒 false）→ 提醒开关**静默不落库**、面板却显示"已保存"（`tests/misc-reminders.test.mjs` 护栏，且用 HEAD 版实现反证过修复前必失败）；③ `shell.openPath` 是 Promise（失败返回错误描述），旧代码"发出去不管"→ 打开文件失败仍返回 `{ok:true}`；④ `resolveFfplay()` 返回 `false` 时被当命令传给 `spawn`；⑤ `llmChatStream` 实际返回 `string | LLMResponse`（类型此前谎报纯文本）、`withLLMTimeout` 把流式文本类型擦成 `unknown`、`traceTool` 因解构默认值被推断成"只许 null"、`initPlan` 的 `steps` 被推断成 `never[]`。护栏同步迁移口径：源码扫描型断言改读**实现文件**（`.ts` + `.mjs` 桶），内容哈希新鲜度（speech-queue）改盯 `.ts`——否则"实现迁走、`.mjs` 变一行桶"会让护栏静默失明

---

## 评测（Benchmark）

<!-- EVAL_BADGE -->

双层评测体系 + 指标/门禁/消融/可视化，报告存 `benchmark/reports/`（`eval_summary.csv` 为回归底座）：

### Layer A：模型基线（`npm run bench` / `bench:quick` / `bench:ablation`）

- **讲解质量**：**38 道**真实面试题（code/predict/coverage/trace 四型），客观判定为主（代码测试断言 / stdout 比对 / 必考要点覆盖率）+ LLM-as-Judge 双评 + CRAG 事实判官
- **分类/检测/匹配**：16 分类 / 12 检测 / 12 静态匹配（`benchmark/static.json`）
- **指标**：综合分 + pass@1 + 成本（tokens/USD，solver vs judge 分账）+ 延迟（p50/p95）+ 失败分类，全部落 `eval_summary.csv`
- 判官金标校验（20 对，`--judge-check`，CI 有 key 时跑）
- **当前全量基线（2026-08-28 实测，38 题，`benchmark/reports/latest.json`）**：综合 **96/100** —— 讲解 91（客观代码验证 4/5）/ TRACe 90 / 真实性 CRAG 86（correct 30·acceptable 3·missing 1·incorrect 4）/ 分类 100 / 检测 100 / 静态 100；171 次调用 **$0.22**、p50 17s / p95 78s、**失败 1 次**（`metrics.failCount=1`，pass@1 80）
  - 注：基线经 **Ollama 端点**跑出（`latest.json` 的 `envelope.model` 记录为 `deepseek-v4-flash`）——与官方 API 基线**跨模型不可直接比**（Layer A 反映"模型 + prompt 组合能力"，换模型即换基线）；同模型对比看 `eval_summary.csv` 同 hash 行

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

`lib/llm.ts` 检测网关 `HTTP 200 + 空 content` → 自动重试/failover；上下文压缩 token 估算触发（`COMPACT_BUDGET`/`COMPACT_KEEP_RECENT` 可配），量化验证 70%+ 缩减。

---

## 工程质量门禁

> 数字为 **2026-09-11 实测**（全部为已提交 HEAD 状态；工作区干净）。

| 门禁 | 命令 | 当前状态 |
|---|---|---|
| 单元/集成测试 | `npm test` | ✅ **1282/1282 通过**（1243 单元 + 39 集成，147 个测试文件，mock LLM 无 key 可跑） |
| 类型检查（lib，双 tsc） | `npm run typecheck` | ✅ 0 错误（宽松 checkJs 覆盖 `.mjs` + `tsconfig.strict.json` 查 `lib/plugins/desktop` 的 `.ts`，strict 下同样 0） |
| 桌面端类型检查 | `npm run typecheck:desktop` | ✅ 0 错误（`kanban-api.d.ts` 83 个接口方法与 preload 实现**双向一致**——实测 83=83，子集关系由 `tests/ipc-declaration.test.mjs` 强制）——**2026-09-11 修复**：该配置此前漏开 `allowImportingTsExtensions`，被 133 处 TS5097 噪音掩盖了真实的 `MusicResult.catch` 类型错（该步骤以前从未在 CI 上跑到） |
| Lint | `npm run lint` | ✅ **0 error 0 warning**（全仓库，含面板/渲染层/脚本/测试） |
| 渲染层一致性 | `tests/react-panel.test.mjs` / `tests/react-tabs.render.test.mjs` / `tests/vue-tabs.render.test.mjs` / `renderer-sizes.test.mjs` | ✅ 三态注册表一致 + **两侧全 Tab 渲染**（分发/同源/特色标注/UI 不变量/对称卸载）+ 体积数据新鲜度 |
| 契约与接口回归 | `tests/review-routes.test.mjs` / `tests/misc-reminders.test.mjs` / `tests/contracts.test.mjs` | ✅ TS 迁移顶出的两条恒 500 路由 + 提醒开关静默不落库已修并锁死（含契约出参校验） |
| 渲染产物新鲜度 | `npm run check:renderer` / `tests/renderer-bundle-fresh.test.mjs` | ✅ **内容哈希口径**（2026-09-11 从 mtime 改成哈希：mtime 会因注释级改动/CI checkout 顺序误报，且实测重建后字节完全相同） |
| node:test 协议通道守卫 | `tests/protocol-guard.test.mjs`（`--import tests/protocol-guard.mjs`） | ✅ 9/9：测试子进程的 stdout 只留 v8 协议帧，诊断文本改道 stderr（此前整文件假失败的真因，见下） |
| UI 机器指标巡检 | `node scripts/shot-panel.mjs` | ✅ 8 类指标（对比度/小字/可访问名/点击目标/裁切…）为零 |
| 复习卡交互回归 | `node scripts/_verify-review-scroll.mjs` | ✅ 10/10（固定浮层滚轮死区 / 答案区可滚 / 评分按钮可达） |
| ASR 长音频回归 | `node scripts/_asr-ab.mjs <wav> <gt.txt>` | ✅ 分段后 CER 0%（对照整段 4.1%；需自备样本与真值） |
| 知识库检索评测 | `node scripts/kb-eval.mjs` | ✅ 三条基线 top5 命中率：短语 0/20 → 词项 7/20（35%）→ **混合 11/20（55%）**（评测集为本机真实问题，见 `data/kb-eval.json`；脚本会自动报告向量覆盖率，向量腿未生效时不下结论） |
| 评测数据合法性 | `npm run bench:validate` | ✅ 6 数据集全过（脏数据 exit 1） |
| Agent 能力评测 | `npm run bench:agent` | ✅ 19/19（mock LLM，与模型无关） |
| 模型基线 | `npm run bench` | ✅ 2026-08-28 全量 38 题实测：综合 96/100（Ollama deepseek-v4-flash:cloud，$0.22）——详见评测章节 |
| 回归门禁 | `npm run bench:gate` | 分层门禁（硬红 exit 1） |
| 语音评测 | `npm run voice:score` / `voice:audit` | 内容完整度/音色/节奏/污染 + 末尾完整度审计 |
| 路由注册表回归 | `tests/routes-registry.test.mjs` | 路由总数护栏（当前 **155 条**）+ 契约覆盖率护栏（≥15 路由挂契约） |
| CI | `.github/workflows/ci.yml` | push/PR：install + React 面板构建 + **test + bench:validate + npm audit + coverage + typecheck（宽松/strict/desktop）+ 类型探针 + lint + build/check:renderer + bench:agent**（2026-09-11 修：此前每次 push 都红——audit 报 js-yaml 高危、测试挂在 node:test 协议通道污染上；audit 步骤本地复现需 `--registry=https://registry.npmjs.org`，本机 npmmirror 未实现 audit 接口会假绿） |
| 每周评测 | `.github/workflows/weekly-eval.yml` | 全量 Layer A + web 任务 + 消融 + 门禁 + 徽章/趋势提交；**2026-09-11 修**：旧版 job 级 `if` 使用了 `env` 上下文（GitHub 在 `jobs.<job_id>.if` 只允许 github/needs/vars/inputs）导致 workflow 文件校验不通过——每次 push 都产生一个 0 秒 0 job 的失败 run（run 名退化成文件路径）；现改为 step 级 gate，未配置 `DEEPSEEK_API_KEY` 时整条流水线跳过并保持绿色；**尚未有真实产物**（徽章/`trend.svg` 需带 key 跑一次才会生成并提交） |

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

**Q：知识库检索感觉只有关键词在起作用？**
向量腿依赖 bge 模型，首次检索时从 huggingface.co 下载——国内直连会 `fetch failed` 并**静默降级为纯关键词**（不报错，所以很容易没发现）。在项目根目录 `.env` 里加一行（或设同名环境变量）后重启桌宠即可：`MIANSHI_HF_ENDPOINT=https://hf-mirror.com/`（`.env` 由根目录 `config.mjs` 注入 `process.env`，未设置的键才注入）；缓存落在 `<data>/models/transformers`；首次检索会后台补齐向量（本机 1478 段约 52s，检索结果头部会显示 `向量 N/M`）；自建 20 题评测 top5 命中率 35% → 55%（`node scripts/kb-eval.mjs` 可复跑）。

**Q：怎么打安装包？**
```bash
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist    # release/ 下 NSIS 安装包 + 便携版
```

---

## 路线图

- [x] 爬取引擎 / 学习闭环 / 对话 agent / 桌宠（Live2D/气泡/全屏隐藏）
- [x] 面试实录、多轮回环审计（修复 50+ 断裂点）、设置中心全可配
- [x] 语音系统：GPT-SoVITS 合成 + 评测/审计 + 训练流水线 + 交互重设计
- [x] 纵向拆分（工程质量）：路由注册表插件化（core + 12 业务域）、agent→tools 分层、面板按域拆文件、契约层（Phase 2）
- [x] 事件驱动内核（P0）：事件总线 + 自主决策 + CC 伴侣 watcher + 场景装配（P1）
- [x] 双层评测体系：数据集治理/指标/门禁/消融基线/判官校准 + 每周评测 workflow（**已修好加载失败，待带 key 产出首份徽章/趋势**）
- [x] MCP 分发闭环：13 工具（含 project-guide / dev-history 讲解与开发历史文档）+ 数据自动探测 + 发布瘦身（7 deps）+ 完整分发文档
- [x] 渲染层三态并行：8 Tab × 原生 / React / Vue + 三态对比卡（dist 实测体积）+ 注册表一致性与体积新鲜度护栏
- [x] UI 批量优化：8 类机器指标归零（对比度/小字/可访问名/点击目标/裁切…）；复习卡可读性修复（答案区限高可滚、固定浮层滚轮死区兜底）
- [x] 本地 ASR 质量治理：长音频能量谷分段识别（样本 A：CER 4.1% → 0%、6.7s → 4.8s；样本 B 见 `lib/speech.ts` 注释 5.5% → 4.5%）+ 术语/同音词纠错 + 真实样本落盘诊断开关
- [x] 本地知识库混合检索：段落级索引（147 篇 → 1478 段）+ FTS5 BM25 + bge 向量 → RRF 融合 + 追问段加权；**2026-09-11 补齐索引期向量化**（此前 vector 列只读不写，混合检索实际退化成纯关键词：实测 35% → **55%**）+ 镜像支持（`MIANSHI_HF_ENDPOINT`）
- [x] CI 全绿治理：js-yaml 高危 override、weekly-eval workflow 失效、node:test 协议通道污染（整文件假失败）、typecheck:desktop 配置缺失、渲染产物新鲜度改内容哈希
- [x] 全量 TS 迁移：**四阶段全部完成**——核心业务 → 编排层 → 服务入口（契约/路由/工具/适配器/平台）→ 插件（12 路由域 + 模板）与桌面（widget-server / tts-edge / foreground / voice-pack / main / speech-queue）；实现文件全 `.ts`，`.mjs` 只剩同名一行桶（`lib` 122 `.ts` / 66 桶、`plugins` 14 / 14、`desktop` 11 / 7），strict 门禁覆盖三层
- [x] 感知层价值升级：**会话时间线 + 项目投入统计**（`lib/agent-timeline.ts` + 驾驶舱 Tab；本机实测 764 会话 / 覆盖 256.5h / 活跃 45 天 / 14655 轮 / 15003 工具调用）——替代零信息量气泡播报
- [ ] 感知层后续：仅在"窗口失焦 / 长任务结束 / 任务失败"时才播报，且文案带项目名与耗时
- [ ] 实时 TTS 句子级流水线（开发中：speech-queue + GPT-SoVITS 本地引擎）
- [x] companion-poller 主进程接线（事件驱动表达 → 桌宠气泡；`desktop/main.ts` 已 import `startCompanionPoller` 并在 `autonomy != off` 时启动，2s 拉 `pet-events`）
- [x] 三态渲染层补口：Vue 侧全 Tab 渲染护栏（`tests/vue-tabs.render.test.mjs`）+ 未登记 Tab 不再静默挂错面板（与 React 侧同形守卫）
- [ ] 开机自启（写注册表 / `app.setLoginItemSettings`，当前需手动双击启动或桌面快捷方式）
- [ ] 知识库精排接 UI（`/api/knowledge/paragraphs/search-reranked` 与 `/api/knowledge/followups-to-cards` 两条路由已实现+有测试，但前端尚无入口）
- [ ] 判官长官方差控制（金标回归 + 更多抽检）
- [ ] 评测集全量扩容（questions → 60+，渐进积累）
- [ ] P2 动作层（情绪→Live2D 动作映射）、P3 反思闭环（trace 失败模式 → 调整技能/提示词）
- [ ] Monorepo / PKCE / 受信任面板宿主（放后可选）

---

## 📦 开源说明

- **许可证**：MIT（见 [LICENSE](LICENSE)）
- **仓库不含**：本地数据（`data/`）、ASR 模型（`models/`）、`.env`（密钥）；**含**自训练声线（`assets/voice/`，开箱即用）
- **测试**：`npm test` 1282 用例全绿（1243 单元 + 39 集成，mock LLM，CI 零成本）；评测体系见上文
- **插件化路线**：宿主（真白）+ 插件（秋招助手）架构见 [`docs/plugin-architecture.md`](docs/plugin-architecture.md)

---

*由真白驱动 · 真白陪你上岸*




