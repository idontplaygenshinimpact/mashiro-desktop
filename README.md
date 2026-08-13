# 真白 · 前端秋招桌宠 Agent（mianshi-agent）

> 🎀 一个会爬面经、讲题目、陪你复盘的前端秋招 AI 桌宠。椎名真白（樱花庄的宠物女孩）等你投喂面经链接，也等你跟她对话。

---

## 这是什么

一套完整的前端秋招学习系统，三合一：

| 模块 | 作用 |
|---|---|
| **爬取引擎** | 自动逛牛客/掘金/CSDN，抓取前端 & AI Agent 面经/笔试题，AI 筛选出**具体题目**并完整讲解（结论/原理/JS实现/边界），归档 Markdown |
| **学习闭环** | 从产出提炼"优先学习清单" → 勾选完成 → 复盘出题 → 判分 → 错题自动进入**薄弱点**，下次优先学 |
| **桌宠** | Electron 透明窗口 + Live2D 椎名真白，桌面悬浮、点击对话、气泡提醒、全屏自动隐藏、开机自启 |

对话式 agent：在桌宠输入框直接说"帮我搜 React 面经并讲讲事件循环"，它自己规划任务、调工具、给答案。

---

## 快速开始

### 环境要求

- Node.js >= 22
- Windows 10/11（桌宠依赖 Win32 API）
- DeepSeek API Key（或任意 OpenAI 兼容接口）

### 安装

```bash
cd D:\mianshi-agent
npm install
# 国内网络需指定镜像下载 Chromium：
$env:PLAYWRIGHT_DOWNLOAD_HOST = "https://npmmirror.com/mirrors/playwright"
npx playwright install chromium
```

### 配置

编辑 `.env`（API Key 优先级：`.env` > 环境变量 `DEEPSEEK_API_KEY`）：

```
# 走 OpenCode Go 订阅额度（省钱）或官方 API
DEEPSEEK_API_KEY=sk-xxxx
# 可选：切换模型/端点
# MIANSHI_MODEL=deepseek-v4-flash
# DEEPSEEK_BASE_URL=https://opencode.ai/zen/go/v1
```

> 默认端点 `https://opencode.ai/zen/go/v1`（OpenCode Go 订阅），改用官方 API 时设为 `https://api.deepseek.com/v1`。

### 启动

```bash
# 桌宠（自动拉起后台数据服务）
node D:\mianshi-agent\node_modules\electron\dist\electron.exe D:\mianshi-agent\desktop\main.mjs

# 或一键启动脚本
D:\mianshi-agent\start-kanban.bat
```

开机自启：脚本已复制到 Windows 启动文件夹（`shell:startup`），如需取消删除 `mianshi-kanban.bat`。

---

## 使用方式

### 1. 桌宠（推荐日常使用）

- **点击真白** → 打开面板：学习清单（勾选/复盘）、爬取进度、最新产出
- **面板底部输入框** → 对话："帮我找 React 面经"、"讲一下防抖节流"、"查字节秋招"
- **拖动角色** → 移动桌宠位置
- **气泡** → 爬取进度 / 新产出 / 学习提醒
- **全屏（B站视频/游戏）** → 自动隐藏，回到桌面自动出现
- **托盘图标** → 右键：显示/隐藏、打开面板、立即爬取、打开输出目录、退出

### 2. 命令行爬取

```bash
# AI 逛网模式：逛 7 个前端/Agent 源，每源挑 3 篇，筛选具体题目 → 完整讲解 → 归档
node discover.mjs

# 手动模式：处理 links.txt 里的指定链接
node run.mjs

# 自定义起始页 / 数量
node discover.mjs "https://juejin.cn/search?query=React面经" 5
```

产出目录：`output\<日期>_discover\`，每题一个 Markdown（题目/结论/原理/JS实现/边界/追问）。

### 3. 学习闭环（面板操作）

1. 点 **✨生成** → 从最新产出提炼 5-8 个优先学习知识点（含"为什么学"）
2. 逐条 **勾选** → 标记完成
3. 点 **📝复盘** → 出验证题 → 输入你的回答 → 提交判分
4. 判分结果自动回流：**错题 → 薄弱点**（下次生成清单优先覆盖）、答对 → 已掌握

---

## 项目结构

```
mianshi-agent/
├── desktop/                  # 桌宠（Electron）
│   ├── main.mjs              # 主进程：透明窗口/置顶/拖拽/托盘/全屏检测
│   ├── foreground.mjs        # Win32 前台窗口检测（koffi FFI，毫秒级）
│   ├── foreground-check.ps1  # （备用）PowerShell 检测脚本
│   ├── preload.js            # IPC 桥接
│   └── renderer/             # 渲染层：Live2D 真白 + 气泡 + 面板 + 对话
├── lib/
│   ├── agent.mjs             # 对话 agent：工具调用循环 + 任务规划
│   ├── ai.mjs                # LLM 调用：分类/挑帖/题目检测/讲解/情报
│   ├── fetch-page.mjs        # Playwright 抓页 + Readability 正文提取
│   ├── memory.mjs            # 记忆：画像/关注点/薄弱点/已掌握/对话历史
│   └── study.mjs             # 学习清单：生成/勾选/复盘出题/判分
├── discover.mjs              # AI 逛网爬取（7 源 → 挑帖 → 讲解 → 归档）
├── run.mjs                   # 手动模式（处理 links.txt）
├── widget.mjs                # 后台数据服务（HTTP :8899）：进度/对话/学习清单 API
├── config.mjs                # 配置（API Key/模型/路径）
├── links.txt                 # 手动模式输入：每行一个 URL
├── data/                     # agent-memory.json（记忆持久化）
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
| **MCP 双向** | Server（暴露 4 工具给 Claude Code/Cursor/OpenCode）+ Client（消费外部 MCP 工具）| server 让外部 agent 调用真白能力；client 让真白调用外部工具（`data/mcp-servers.json` 配置，`mcp__server__tool` 命名空间，失败隔离）|
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

| 门禁 | 命令 | 当前状态 |
|---|---|---|
| 单元/集成测试 | `npm test` | ✅ 156/156 通过 |
| 类型检查 | `npm run typecheck`（tsc --noEmit + checkJs） | ✅ 0 错误 |
| Lint | `npm run lint`（ESLint flat config） | ✅ 0 error |
| 覆盖率 | `npm run coverage` | 12 个核心模块 **93–100%**（ai/interview/knowledge/memory/mcp-client/permission/review/study/trace/atomic-json/emotions/db）；agent.mjs（工具循环）**86.4%**；fetch-page 需真浏览器为人工验证域；llm.mjs 被测试 mock 隔离（统计失真，单文件实测 67%） |
| Agent 能力评测 | `npm run bench:agent` | ✅ 10/10 |
| 模型基线 | `npm run bench` | 综合 94/100（讲解 88 + 分类/检测/静态 100%） |
| CI | `.github/workflows/ci.yml` | push/PR 自动跑：typecheck + lint + test + bench:agent |

---

## 常见问题

**Q：每次怎么启动？**
双击 `D:\mianshi-agent\start-kanban.bat`（最小化启动 Electron 桌宠）。桌宠主进程会自动拉起后台数据服务（widget，端口 8899）并守护它，**不需要单独启动 widget**。若设置了开机自启（`shell:startup` 里的 `mianshi-kanban.bat`），平时开机即自动运行，无需手动操作。

**Q：改完代码后功能没生效 / 面板报 "Not Found" / "is not valid JSON"？**
运行中的 widget 是旧代码进程（桌宠一直没重启）。**每次代码改动后请重启桌宠**：托盘退出或 `Get-Process electron | Stop-Process -Force`，再双击 `start-kanban.bat`。验证是否新版：浏览器打开 `http://127.0.0.1:8899/api/learning`——返回 JSON 文档清单 = 新版；返回 `Not Found` = 旧进程，重启桌宠即可。

**Q：桌宠不显示？**
杀掉 electron 进程重启：`Get-Process electron | Stop-Process -Force`，再运行启动命令。

**Q：爬取很多 404？**
牛客部分帖子被删/需登录，属正常。已内置无效页检测（自动跳过），多源覆盖降低影响。

**Q：对话很慢？**
首次调用要启动 Chromium（几秒），搜索 2 站并行约 15 秒，完整"搜索+讲解"约 1 分钟属正常。简单问题直接问（不触发搜索）会快很多。

**Q：想换模型/端点？**
改 `.env`：`DEEPSEEK_BASE_URL`（OpenCode Go 或官方 API）、`MIANSHI_MODEL`（`deepseek-v4-flash` / `deepseek-v4-pro`）。

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
- [ ] 进化闭环：内置评测集（LLM-as-Judge）+ 自动改进 prompt

---

*由 mianshi-agent 驱动 · 真白陪你上岸*
