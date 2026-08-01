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

## 常见问题

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
- [ ] Repair：失败自动重试/换源降级
- [ ] 主动推送：按关注点定时巡检新内容
- [ ] 进化闭环：内置评测集 + 自动改进 prompt

---

*由 mianshi-agent 驱动 · 真白陪你上岸*
