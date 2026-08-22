# 真白 · Mashiro Desktop（mashiro-desktop）

> 🎀 一个会爬面经、讲题目、陪你复盘的前端秋招 AI 桌宠。椎名真白（樱花庄的宠物女孩）等你投喂面经链接，也等你跟她对话。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![CI](https://github.com/wyyai/mashiro-desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/wyyai/mashiro-desktop/actions/workflows/ci.yml)

---

## 这是什么

一套完整的前端秋招学习系统，三合一：

| 模块 | 作用 |
|---|---|
| **爬取引擎** | 自动逛牛客/掘金/CSDN，抓取前端 & AI Agent 面经/笔试题，AI 筛选出**具体题目**并完整讲解（结论/原理/JS实现/边界），归档 Markdown |
| **学习闭环** | 从产出提炼"优先学习清单" → 勾选完成 → 复盘出题 → 判分 → 错题自动进入**薄弱点**，下次优先学；FSRS 间隔复习 + 选择题自测 + 到期提醒 |
| **专项练习** | 牛客 TOP101 算法题（免登录随时刷）+ **手写/算法题库 91 道**（本地沙箱判题：写完直接跑测试，通过自动记进度，答错回流薄弱点） |
| **模拟面试** | 面试官按 STaR 五维评分、追问深挖、复盘报告 + 薄弱点回流；**设置中心上传简历自动接面试官项目拷打** |
| **桌宠** | Electron 透明窗口 + Live2D 椎名真白，桌面悬浮、点击对话（短句语音反馈）、气泡提醒、全屏自动隐藏、开机自启 |
| **求职闭环** | 简历 → 方向画像 → 岗位匹配/投递 → 笔试日程 → 面试邀约（邮箱自动识别）→ 全节点回流（LORF 规则引擎给"现在最该做什么"） |

对话式 agent：在桌宠输入框直接说"帮我搜 React 面经并讲讲事件循环"，它自己规划任务、调工具、给答案。

> **个人数据闭环**：简历/岗位/日程/学习进度 全链路互通，自动识别邮箱面试邀约（含"时间待定"条目）、投递状态实时同步、笔试进入统一日程表——不用手动搬数据。

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

**全部可在面板「⚙️ 设置」配置，无需改文件**（开源复用友好）：

| 配置项 | 面板入口 | 说明 |
|---|---|---|
| API Key / Base URL / 模型名 | 设置 → LLM 服务配置 | 接任意 OpenAI 兼容端点（含本地 Ollama/中转）；配了 Base URL 即单端点直连 |
| 方向画像 / 知识树模板 | 设置 → 方向画像 / 知识树 | 转方向/开源复用改这里即可，全链路（面试/出题/巡检/分组）跟随 |
| 邮箱（自动检查开关） | 设置 → 邮箱 | 授权码仅存本机；每 30 分钟自动拉取识别面试邀约 |
| 自动巡检 + 每日 token 预算 | 设置 → 自动化 | 关注点定时搜新面经 → 讲解 → 通知；token 上限防超支 |
| 本地知识库（RAG） | 设置 → 本地知识库 | 默认关；**纯关键词检索（FTS5）零模型零内存**，秒级构建 |
| 招聘平台（BOSS） | 校招 Tab → 平台账号 | 启用/登录态/投递设置/招呼语 |

> 兜底：`.env` 仍生效（`DEEPSEEK_API_KEY`/`MIANSHI_MODEL`/`DEEPSEEK_BASE_URL`/`RAG_EMBED_MODEL` 等），面板配置优先。

### 启动

```bash
# 方式一：桌面快捷方式（首次运行 start-kanban.bat 会自动创建「真白桌宠」图标）
# 方式二：一键启动脚本（无黑窗，重复双击会被单实例锁拦截并聚焦已运行窗口）
start-kanban.bat

# 方式三：直接命令（桌宠会自动拉起后台数据服务）
node node_modules\electron\dist\electron.exe desktop\main.mjs
```

**改代码后一键重启**：面板右上角「♻️」按钮（确认后桌宠 + 后台服务一并重启，约 3-5 秒）；或托盘退出后重新运行启动脚本。开机自启：注册表 Run 键 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `mashiro-desktop` 项（指向启动脚本），如需取消删除该注册表项。

---

## 使用方式

### 1. 桌宠（推荐日常使用）

- **点击真白** → 打开面板：学习清单（勾选/复盘）、爬取进度、最新产出
- **面板底部输入框** → 对话："帮我找 React 面经"、"讲一下防抖节流"、"查字节秋招"
- **拖动角色** → 移动桌宠位置
- **气泡** → 爬取进度 / 新产出 / 学习提醒
- **全屏（B站视频/游戏）** → 自动隐藏，回到桌面自动出现
- **托盘图标** → 右键：显示/隐藏、打开面板、立即爬取、打开输出目录、退出
- **形象切换** → 面板「💬 对话」Tab 顶部「🎀 桌宠形象」：真白·旅行装/水手服/私服 + 时雨，点击即换、重启记忆（本地模型扫描 `node_modules/live2d-widget-model-*`）

### 2. 预设技能（对话直接触发，开箱即用）

| 技能 | 触发方式 | 能力 |
|---|---|---|
| 🧾 **frontend-cheatsheet** | "讲一下事件循环/闭包/浏览器缓存…" | 八股讲解自动按高频考点清单覆盖追问点，防漏讲 |
| 🔥 **interview-warmup** | "明天面试怎么准备/面试前热身" | 5 分钟流程：摸底清单→搜目标公司面经→演练考点→收尾回流 |
| ⚖️ **tech-compare** | "React 和 Vue 哪个好/Vite vs Webpack" | 统一对比框架（结论→差异表→机制本质→选型→追问） |
| 📄 **resume-coach** | "帮我看看简历/简历怎么改"（贴简历） | 结构化优化：亮点/风险/量化改进示例/面试预设问题 |
| 🏢 **company-intel** | "字节面什么/帮我查 XX 面经" | 搜该公司面经→抓正文→汇总 TOP 考点+真题线索+准备建议 |
| 🐙 **github-repo** | "React 仓库多火" | GitHub 仓库信息（stars/语言/更新时间） |

> 技能即插即用：新增 `skills/<名>/` 目录即可，`POST /api/skills/reload` 热加载，开发文档见 `skills/README.md`。

### 3. 命令行爬取

```bash
# AI 逛网模式：逛 7 个前端/Agent 源，每源挑 3 篇，筛选具体题目 → 完整讲解 → 归档
node discover.mjs

# 手动模式：处理 links.txt 里的指定链接
node run.mjs

# 自定义起始页 / 数量
node discover.mjs "https://juejin.cn/search?query=React面经" 5
```

产出目录：`output\<日期>_discover\`，每题一个 Markdown（题目/结论/原理/JS实现/边界/追问）。

### 4. 学习闭环（面板操作）

1. 点 **✨生成** → 从最新产出提炼 5-8 个优先学习知识点（含"为什么学"）
2. 逐条 **勾选** → 标记完成
3. 点 **📝复盘** → 出验证题 → 输入你的回答 → 提交判分
4. 判分结果自动回流：**错题 → 薄弱点**（下次生成清单优先覆盖）、答对 → 已掌握

### 5. 专注（番茄钟 + 桌宠陪伴）

- **开始专注**：选 25/45 分钟，可填**本次目标**（如"学事件循环"）——完成时目标自动回流学习进度
- **番茄循环**：到点自动完成 → 自动进入 5 分钟休息 → 休息到点提示开始下一轮（可跳过休息）
- **分心监督**：前台窗口命中黑名单（标题关键词 / `进程名:Xxx.exe` / `/正则/`）→ 真白气泡 + 日语语音提醒（3 分钟冷却）；**白名单**（IDE/浏览器）命中不报
- **陪伴**：开始/完成/休息结束/中途鼓励（每 10 分钟）都有对应气泡与语音场景
- **统计**：今日分钟/次数/分心 + 连续天数（streak）+ 近 7 天柱状图

### 6. 语音交互（真白声线）

- **单击桌宠** → 短句应答（2-8s 快速反馈，部位人设：摸头/戳脸/身体/手）
- **空闲关怀**（5 分钟无交互）→ 长句独白（GPT-SoVITS 真白声线 20-30s，内容完整）
- **修改/暂停播放器**：`desktop/voice-pack.mjs`（ffplay → SoundPlayer 兜底；长句播放中不被打断）
- **合成长句**：`npm run voice:synth`（分句多采样最优拼接）
- **质量评测**：`npm run voice:score`（内容完整度/音色/节奏/污染 → A-D 分 + 历史对比）；`npm run voice:audit`（含"话没说完"末尾完整度预警）
- **训练新声线**：`npm run voice:train -- <step>`（详见 [`scripts/voice-train/README.md`](scripts/voice-train/README.md)：原始音频 → 数据准备 → GPT/SoVITS 训练 → 权重接入 → 合成 → 评测，全流程内置）

**语音输入**（面板 🎤 说话 → 文字回填输入框，本地离线识别、零 API key）：

- **引擎**：默认 sherpa-onnx paraformer-zh（中文 SOTA 级、CPU 实时率 5x+）；首次使用先下载模型：`npm run voice:model`（~230MB，国内镜像；直连失败时设 `HTTPS_PROXY` 重跑）
- **不卡 UI**：识别在 worker 线程（`lib/speech-worker.mjs`）——推理是同步计算，放主进程会冻结整个桌宠（历史卡顿根因）
- **识别质量**：录音端 VAD 自动裁头尾静音（防噪声被脑补成汉字）+ 16k 采样率兜底重采样；whisper fallback（`SPEECH_ENGINE=whisper` 可切，慢但免下载）

> 🔊 **声音资产**：本仓库不含语音文件（自训练声线，~94MB 已从 git 移出）。需要语音播放功能时，按 [`scripts/voice-train/README.md`](scripts/voice-train/README.md) 用 GPT-SoVITS 训练你自己的声线，或放入自备 wav（目录结构参考 `assets/voice/` 的 `lines.json` 约定）。

### 7. 本地知识库（RAG，可选）

把面经/学习清单/复习卡/岗位/真题/文档做成可检索库，对话与复习选题可引用。**默认关闭**（评估使用率低 + 省资源），需要时在「⚙️ 设置」开启：

- **纯关键词检索（FTS5 trigram）**：零模型、零内存、秒级构建——不再是 embedding 语义检索
- 开启后自动重建索引；复习选择题生成时可选引用知识库真题素材（带"📚 引用知识库"标记）

---

## 项目结构

```
mashiro-desktop/
├── desktop/                  # 桌宠（Electron）
│   ├── main.mjs              # 主进程薄壳：窗口/托盘/生命周期
│   ├── lib/                  # 主进程拆出模块（无 electron 依赖可单测）
│   │   ├── widget-server.mjs # widget 服务守护（探测拉起/退出清理）
│   │   ├── window-state.mjs  # 窗口位置持久化（防抖保存）
│   │   └── restart.mjs       # 一键重启（bundle 防呆 + 杀进程）
│   ├── voice-pack.mjs        # 语音包播放（短句/长句/场景，防抖+互斥+长句保护）
│   ├── preload.js            # IPC 桥接
│   └── renderer/             # 渲染层（按 Tab 拆 5 文件：panel-core/study/chat/jobs/rest）
├── lib/
│   ├── agent.mjs             # 对话 agent 核心：工具循环 + 权限 + 规划
│   ├── tools/                # agent 工具层（拆分）：schemas/impl/exec-utils/mcp
│   ├── routes/               # widget 全部 HTTP 路由（纵向拆分 13 域：core/review/kb/practice/misc/study/interview/jobs/zhenti/oj/focus/mail/rss）
│   ├── career.mjs            # 方向画像中心（简历 → 方向 → 知识树联动）
│   ├── knowledge.mjs         # 知识树模板（frontend/backend/algorithm 可配置）
│   ├── patrol.mjs            # 主动巡检（关注点定时搜帖→讲解→存档→通知）
│   ├── rag.mjs               # 本地知识库（FTS5 关键词检索 + 开关）
│   ├── mail.mjs              # 邮箱邀约识别日程（IMAP → LLM → schedule_events）
│   ├── study.mjs / review.mjs / interview.mjs / quiz.mjs
│   ├── job-platforms.mjs / platform-accounts.mjs / platforms/
│   ├── context-providers.mjs # 个人数据注册表（MCP 单数据源）
│   ├── skills.mjs / hooks.mjs / subagent.mjs / llm.mjs / ai.mjs
│   └── db.mjs                # node:sqlite 主存储（WAL）
├── discover.mjs / run.mjs    # 爬取入口（核心逻辑在 lib/）
├── widget.mjs                # 后台数据服务（HTTP :8899）——已无内联路由，纯服务生命周期
├── mcp-server.mjs            # MCP Server（暴露个人数据/工具给外部 agent）
├── scripts/
│   ├── voice-train/          # 语音训练完整流程（README.md 内置）
│   ├── synth-mashiro-long.py / score-voices.py / audit-voices.py  # 合成长句/评测/审计
│   └── test-module.mjs       # 按模块跑测试（升级单模块不用全量）
├── skills/                   # Skills 插件（即插即用）
├── config.mjs                # 配置（API Key/模型/多 Provider）；面板设置>环境变量
├── data/                     # mianshi.db + 配置 + 语音评分缓存
└── output/                   # 产出：日期目录 + Markdown 题库
```

---

## 工作流

```
自动巡检（7 源：牛客前端/Agent + 掘金 + CSDN）
  ↓ Playwright 抓列表页 → AI 挑帖（前端/Agent 优先）
  ↓ 抓正文 → 方向过滤（frontend/agent）→ 具体题目检测（攻略文跳过）
  ↓ 完整讲解（结论→原理→JS实现→边界）→ 归档 Markdown
  ↓ 学习清单生成（含"为什么学"+ 验证题）
  ↓ 用户勾选完成 → 复盘出题 → 判分
  ↓ 错题 → 薄弱点（记忆回流）→ 下次优先学
```

对话模式（桌宠输入框）：

```
用户："帮我搜 React 面经并讲解核心考点"
  → agent 规划 → search_posts(牛客/掘金并行) → fetch_page
  → detect_questions 提炼 → solve_question 讲解 → 基于记忆画像输出
```

投递闭环（多向驱动，非单向管道）：

```
                    ┌─────────────┐
        ┌──────────▶│  ① 方向选择  │◀───────────┐
        │           └──────┬──────┘            │
        │    learnForDir   │  setTargetDir     │ 岗位市场反馈
        │      (方向→学习)  │  (方向→岗位)       │ (岗位→方向)
        ▼                  ▼                   │
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  ② 学习      │───▶│  ③ 岗位获取  │───▶│  ④ 面试      │
│ 清单/复习/薄弱点│    │ 逛网/平台投递 │    │ 模拟/实录     │
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │  get_study_plan  │  按岗面试         │ 薄弱点回流
       │  (学习→面试)      │  (岗位→面试)      │ (面试→学习)
       │                  │ JD反推考点        │ 短板感知岗位
       │                  │  (岗位→学习)      │ (学习→岗位)
       └──────────────────┴──────────────────┘
```

- **方向 → 学习**：`learnForDirection` 按方向搜面经提炼考点入清单（知识库命中优先）
- **方向 → 岗位**：目标方向驱动岗位匹配推荐（简历/方向权重）
- **岗位 → 学习**：`deriveStudyFromJob` 岗位 JD 反推考点 → 学习清单（"投之前知道要补什么"）
- **岗位 → 面试**：`startInterviewForJob` 按岗位 JD 出题（面试官 focus = 岗位技术栈考点）
- **学习 → 面试**：面试官优先考清单未完成项；**学习 → 岗位**：`suggestJobsForWeakPoints` 短板感知（不要求短板的岗位可直接投 / 涉及短板的先补强）
- **面试 → 学习**：薄弱点自动回流清单 + 复习卡
- **行为数据全回流**：复习答错 → 薄弱点 failCount+1；真题错题 → 清单+复习卡+薄弱点；OJ 刷完 → 刷题进度；手写/算法题通过 → 学习进度 + 题库进度、答错 → 薄弱点；专注完成 → 学习进度；投递成功 → 备战公司记录
- **全节点 → 下一步**：`loopSuggest` 规则引擎消费全部数据（面试日程 > 复习到期 > 薄弱点 > 清单 > 投递备战 > 岗位 > 刷题/专注 > 方向），给出"当前最该做的事"（面板「🔄 学习-求职闭环」区块 / 对话问"我现在该干什么"）
- **专注目标推荐**：`suggestFocusGoal` 从到期复习卡/薄弱点/清单未完成推荐"现在最该专注学什么"（面板 ⏱️ 专注 Tab 一键填入）

---

## 关键技术点

- **Live2D 渲染**：`pixi-live2d-display` + Cubism2 runtime，椎名真白模型（Sakurasou/mashiro·旅行装）。踩坑记录：必须 `sharedTicker: true`（否则 deltaTime 为 NaN 模型不渲染）、不能手动调 `model.update()`（会污染 deltaTime）
- **透明窗口 + WebGL**：Windows 上透明窗口 WebGL 合成有坑，canvas 背景必须 `transparent`；`win.showInactive()` 避免抢焦点导致全屏检测失效
- **全屏检测**：koffi FFI 直调 `GetForegroundWindow`/`GetWindowRect` 对比主屏尺寸（毫秒级，替代慢速 PowerShell）
- **API 兼容**：DeepSeek 的 function calling 走 OpenAI 协议；Go 网关不支持 `response_format=json_object`（400），已改为提示词约束 + 提取

---

## 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  桌面层（Electron）                                       │
│  ┌─────────────┐    ┌──────────────────────────────┐    │
│  │ 桌宠窗口     │    │ 面板窗口（模拟面试/复习/清单/对话）│    │
│  │ Live2D 真白  │    │ 学习弹层(SSE流式/追问/归并)     │    │
│  │ 点击/拖拽/语音 │    │ 运行监控(LLM调用/token统计)    │    │
│  └──────┬──────┘    └──────────────┬───────────────┘    │
│         │ IPC(preload)             │ IPC                  │
└─────────┼──────────────────────────┼──────────────────────┘
          ▼                          ▼
┌─────────────────────────────────────────────────────────┐
│  widget.mjs（HTTP :8899 数据服务）                        │
│  /api/chat /study-* /interview-* /review-* /observability│
└──────────────┬──────────────────────────────────────────┘
               ▼
┌─────────────────────────────────────────────────────────┐
│  Agent 核心（lib/）                                      │
│  agent.mjs  工具循环（while + tool_calls + validateArgs） │
│    ↓ 调用链可观测（trace_llm / trace_tools）              │
│  llm.mjs    统一 LLM 客户端（failover / 重试 / SSE）      │
│  ai.mjs     讲解/分类/挑帖/归并（solve/cluster/consolidate）│
│  memory.mjs 记忆（SQLite + origin 溯源防污染）            │
│  study.mjs  学习清单  review.mjs FSRS复习  knowledge.mjs │
│  db.mjs     node:sqlite 主存储（WAL）                    │
└─────────────────────────────────────────────────────────┘
```

## 技术选型（为什么这么做）

| 决策 | 选择 | 理由 |
|---|---|---|
| **Agent 循环** | 自研工具循环（非 LangGraph/LangChain）| 与 Claude Code/OpenCode 同款范式：单 agent 线性循环用 while + tool_calls 最可控。LangGraph 是状态机编排框架，解决多分支/checkpoint/人工审批，与 coding agent 的核心矛盾（流式/上下文/权限/错误恢复）不重叠 |
| **流式交互** | SSE + IPC 转发 | 面板直接 fetch 会撞 webSecurity，main 进程转发 SSE → 渲染层事件，逐 token 打字机渲染 |
| **记忆存储** | node:sqlite（`mianshi.db`，WAL）| 内置零依赖（Electron 43 绑定 Node 24 免 rebuild），规范化小表 + origin 溯源列 + FSRS due 拆列索引，替代 4 个 JSON 文件 |
| **LLM 客户端** | 统一 `llm.mjs`：failover + 重试 + SSE | 主端点（OpenCode Go）失败自动降级官方 API；3 次退避重试；流式/非流式统一入口 |
| **记忆防污染** | origin 溯源（owner/agent/untrusted）| 模拟面试/爬虫提炼的伪知识点（"综合能力"）不注入 prompt，只保留可信源（对标 OpenClaw 溯源模型）|
| **MCP 双向** | Server（暴露 8 工具给 Claude Code/Cursor/OpenCode）+ Client（消费外部 MCP 工具）| server 让外部 agent 调用真白能力；client 让真白调用外部工具（`data/mcp-servers.json` 配置，`mcp__server__tool` 命名空间，失败隔离）|
| **Skills 插件** | 目录约定 `skills/<name>/`：SKILL.md 声明（frontmatter 元信息 + 正文使用说明，注入 agent system prompt）+ skill.mjs 可编程（tools 动态工具 / system 角色说明 / hooks 事件监听）；`skill__<skill>__<tool>` 命名空间，权限分级 auto/confirm，加载/执行失败隔离；**热重载**（`POST /api/skills/reload`，开发不重启）+ **运行时查询**（`GET /api/skills` / agent `skill_inspect`，先查接口再写代码） | 参考 DeepSeek Harness / OpenClaw / Claude Code 插件体系：SKILL.md 声明式让 LLM 知道技能何时用，skill.mjs 提供真实能力，目录即插即用；内置示例 `skills/github-repo`，开发文档见 `skills/README.md` |
| **Subagent 编排** | `spawn_subagent` 工具 → 独立子执行器（自身消息上下文、90s 超时、结果截断回填）；一次消息多个 tool_calls 天然并行 | 多篇面经/多知识点/多公司情报并行处理（对标 Claude Code Task）|
| **Hooks 事件** | 轻量注册表（`lib/hooks.mjs`）：before_tool（可拦截）/after_tool/llm_done/chat_done；监听器失败隔离 | 工具策略插件、失败通知、可观测扩展点（对标 Claude Code hooks）|
| **人机交互** | `ask_user`（结构化提问：面板选项按钮点选）/ `plan_mode`（执行计划先确认再动手）/ `todo_init`+`todo_done`（多步任务可见清单）/ 上下文实时计量（面板运行监控显示当前对话 token 用量与压缩阈值） | 对标 DSH ask_user_question / plan mode / todo / tokenMeter：有副作用的任务先过用户关卡，长任务进度可见 |
| **多 Provider** | `config.providers` 路由（`.env` `MIANSHI_PROVIDERS` JSON 数组，任意 OpenAI 兼容端点）；默认主+备双端点 failover | 可同时接 DeepSeek/OpenAI/本地 Ollama，按需切换 |
| **评测闭环** | 五维评分 + 复盘判分回流 + FSRS | 面试→评分→薄弱点→复习卡→再面试，自研遗忘曲线调度 |
| **可观测性** | `trace_llm` / `trace_tools` 表 | 每次 LLM 调用记录 token/耗时/成败，面板"运行监控"实时可见 |

---

## 评测（Benchmark）

两层评测体系，报告存 `benchmark/reports/`：

### Layer A：模型基线（`npm run bench` / `npm run bench:quick`）

- **讲解质量**：10 道真实面试题（8 前端 + 2 Agent 方向），客观判定为主：
  - `code` 型：提取讲解中的 JS 代码注入测试断言，node 子进程跑（过了就是过了）
  - `predict` 型：跑讲解代码块，stdout 与期望输出比对（如事件循环输出顺序）
  - `coverage` 型：讲解文本命中必考要点覆盖率
  - LLM-as-Judge 双评打分（辅助分，带空响应重试）
- **分类/检测/匹配准确率**：面经/招聘/笔试/闲聊分类、题目检测、知识点匹配
- 注意：本层反映「模型 + prompt」组合能力，用于**回归监控**（改 prompt/换模型前后对比），不体现 harness

### Layer B：Agent/Harness 能力（`npm run bench:agent`）

- mock LLM 故障注入，**与模型水平无关**（换任何模型结果一致）
- 覆盖：工具循环执行、参数校验拦截、幻觉工具容错、上下文压缩触发、语音稿分离、学习闭环数据流（面试实录→清单/复习卡、复盘→薄弱点、面试→报告回流）、搜索方向过滤/去重
- 当前结果：**10/10 通过**

### 空响应容错（生产级修复）

网关偶发返回 `HTTP 200 + 空 content`（不报错）——`llm.mjs` 已检测并视为可重试错误，自动走重试/failover 链，避免对话静默空白。

### 上下文压缩（compaction）

生产级实现：token 估算触发（中文 1:1 / 英文 4:1 字符粗估）→ 保留最近 `keepRecent` token 的完整消息 → 中间压缩为带时间戳的摘要注入 → 3 次重试 + 失败降级（丢弃最旧 tool 结果）。参数可配：

```bash
# .env
COMPACT_BUDGET=18000       # body 估算 token 超此值触发压缩（默认窗口 ~30%）
COMPACT_KEEP_RECENT=4000   # 保留最近 N token 的完整消息
```

量化验证（`tests/ai.test.mjs`）：构造超预算对话 → 压缩后 token 减少 70%+ 且保留最近上下文。

---

## 工程质量门禁

> 数字为 2026-08-17 实测（全量重跑），非历史快照。

| 门禁 | 命令 | 当前状态 |
|---|---|---|
| 单元/集成测试 | `npm test` | ✅ **593/593 通过**（含多轮回环审计修复、语音长句保护、邮箱日程、待定邀约、desktop 模块） |
| 类型检查 | `npm run typecheck`（tsc --noEmit + checkJs） | ✅ 0 错误（注意：tsconfig 未开 strict/noImplicitAny） |
| Lint | `npm run lint`（ESLint flat config） | ✅ 0 error / 52 warning（no-unused-vars 为主） |
| 覆盖率 | `npm run coverage` | 测试文件外圈全绿；12 个核心模块 93–100%；agent.mjs 86.4%；llm.mjs 被 mock 隔离（单测失真）；fetch-page 人工验证域 |
| 按模块测试 | `npm run test:module -- <模块>` | 升级单模块只跑它及依赖，不用全量 |
| Agent 能力评测 | `npm run bench:agent` | ✅ 13/13（mock LLM 故障注入，与模型无关） |
| 模型基线 | `npm run bench` | 以 `benchmark/reports/latest.json` 为准 |
| 语音评测 | `npm run voice:score` / `voice:audit` | 内容完整度/音色/节奏/污染 综合评分 + "话没说完"末尾完整度审计（长句合成质量回归监控） |
| 闭环审计 | scripts/_verify-route-parity.mjs 等 | 路由注册表回归测试（`tests/routes-registry.test.mjs`）防拆分丢路由；多轮 workflow 闭环复查已修 30+ 断裂点 |
| CI | `.github/workflows/ci.yml` | push/PR 自动跑：typecheck + lint + test + bench:agent |

---

## 常见问题

**Q：每次怎么启动？**
双击 `start-kanban.bat`（最小化启动 Electron 桌宠）。桌宠主进程会自动拉起后台数据服务（widget，端口 8899）并守护它，**不需要单独启动 widget**。若设置了开机自启（注册表 Run 键 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 下的 `mashiro-desktop` 项），平时开机即自动运行，无需手动操作；重复双击启动会被单实例锁拦截，聚焦到已运行窗口。

**Q：改完代码后功能没生效 / 面板报 "Not Found" / "is not valid JSON"？**
运行中的 widget 是旧代码进程（桌宠一直没重启）。**每次代码改动后请重启桌宠**：托盘退出或 `Get-Process electron | Stop-Process -Force`，再双击 `start-kanban.bat`。验证是否新版：浏览器打开 `http://127.0.0.1:8899/api/learning`——返回 JSON 文档清单 = 新版；返回 `Not Found` = 旧进程，重启桌宠即可。

**Q：桌宠不显示？**
杀掉 electron 进程重启：`Get-Process electron | Stop-Process -Force`，再运行启动命令。

**Q：爬取很多 404？**
牛客部分帖子被删/需登录，属正常。已内置无效页检测（自动跳过），多源覆盖降低影响。

**Q：对话很慢？**
首次调用要启动 Chromium（几秒），搜索 2 站并行约 15 秒，完整"搜索+讲解"约 1 分钟属正常。简单问题直接问（不触发搜索）会快很多。

**Q：想换模型/端点？**
面板「⚙️ 设置 → LLM 服务配置」直接填 API Key / Base URL / 模型名（含本地 Ollama `http://127.0.0.1:11434/v1`，配了 Base URL 即单端点直连）。也可改 `.env` 或用 `MIANSHI_PROVIDERS=[{"name":"deepseek","baseUrl":"...","apiKey":"...","model":"deepseek-chat"},{"name":"local","baseUrl":"http://127.0.0.1:11434/v1","apiKey":"ollama","model":"qwen2.5"}]`（按顺序 failover）。面板配置 > .env。

**Q：怎么打安装包？**
```bash
npm i -D electron-builder   # 已加入 devDependencies
# 国内网络需镜像（下载 electron/nsis 二进制）：
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist                # 生成 release/ 下 NSIS 安装包 + 便携版（约 750MB，含 Chromium）
```

---

## 路线图

- [x] 爬取引擎（前端/Agent 聚焦 + 题目检测 + JS 答案）
- [x] 学习闭环（清单/勾选/复盘/薄弱点回流）
- [x] 对话 agent（工具循环 + 任务规划 + 记忆画像）
- [x] 桌宠（Live2D 真白 / 气泡 / 全屏隐藏 / 开机自启）
- [x] Repair：失败自动重试/换源降级（withRetry + LLM failover）
- [x] 主动推送：按关注点定时巡检新内容（多站搜索 + 全量爬取兜底）
- [x] 讲解增强：流式生成 / 追问补充 / 多条目归并（主题簇 + 关联扩展）
- [x] 面试实录：被问住的知识点一键入清单 + 复习卡
- [x] 可观测性：LLM 调用/token/耗时监控（面板实时可见）
- [x] 系统自检：启动 + 每 6h 自动扫隐患（表堆积自动清理 / 产出污染 / 巡检停摆 / LLM 失败率 / 错误日志 / DB 体积），问题自动修复或弹通知（面板「爬取产出」Tab 可手动检查）
- [x] 产品化基础：多 Provider 路由 / Hooks 事件系统 / Skills 插件机制 / Subagent 编排 / 对话历史恢复 / 面板 CSP + 渲染沙箱 / CI 修复 / 安装包配置
- [x] 纵向拆分（工程质量）：widget → lib/routes 13 域、agent → lib/tools、main → desktop/lib、panel → 5 文件，全部可独立测试；`test:module` 按模块跑
- [x] 多轮回环审计（workflow 并行 + 修复 50+ 断裂点）：简历→面试官、岗位投递状态、邮箱自动检查+待定邀约、笔试进日程、复习答错回流、LLM 配置互清等
- [x] 语音系统：GPT-SoVITS 长句合成（防"话没说完"分块优化）+ 评测/审计（score/audit）+ 训练流程内置（voice-train）+ 交互重设计（单击短句/空闲长句/长句播放保护）
- [x] 设置中心可配：API Key/Base URL/模型、方向画像/知识树模板、邮箱自动检查、巡检 token 预算、本地知识库开关、招聘平台账号——全部免改代码
- [ ] 进化闭环：内置评测集（LLM-as-Judge）+ 自动改进 prompt（bench 评分与 must_cover 已解耦，下一步：在线评测进 CI + 自动改进）

---

## 📦 开源说明

- **许可证**：MIT（见 [LICENSE](LICENSE)）
- **仓库不含**：本地数据（`data/`）、ASR 模型（`models/`，`npm run voice:model` 下载）、自训练声线（`assets/voice/`）、`.env`（密钥）——clone 后按上文配置即可运行
- **插件化路线**：宿主（真白）+ 插件（秋招助手）架构方案见 [`docs/plugin-architecture.md`](docs/plugin-architecture.md)
- **测试**：`npm test`（全量，含 jsdom 面板交互与集成测试）；CI 在 GitHub Actions 全量执行

---

*由 Mashiro 驱动 · 真白陪你上岸*
