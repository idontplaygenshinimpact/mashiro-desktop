# Mashiro MCP 分发文档（npm 包使用指南）

> 真白秋招助手是标准 **MCP Server**：`npm i -g mashiro-mcp` 后，任何支持 MCP 的 AI 工具
> （Claude Code / Cline / Cursor / OpenCode）都能调用真白的能力——不需要桌宠、不需要本项目代码。

## 0. 诚实前置说明（两档可用性，先读这个）

本包是**个人秋招数据助手**的分发，不是通用工具。9 个工具全部围绕秋招场景定制（面经/清单/面试/个人数据），
实测（干净环境，无数据无 key）的可用性分两档：

| 档位 | 工具 | 条件 | 实测结果 |
|---|---|---|---|
| **A. 零配置可用** | 全部 6 个数据工具（get_study_plan / get_jobs_status / get_schedule_events / get_study_progress / get_personal_profile / get_project_archives） | **自动探测**（见 §5）：已有 Mashiro 桌宠数据的用户**装包即连**，数据工具直接返回真实内容（实测：学习清单/岗位/简历真实数据）；全新用户返回空结构 | ✅ |
| **B. 需配置 LLM Key** | solve_question / start_interview（及 search_posts 的 AI 挑帖环节） | 需要 LLM API Key（§1）；**已有桌宠数据的用户自动继承设置中心配过的 key** | 无 key 时快速返回配置提示（已实测，不会卡死） |

> 换句话说：**装包即可连、结构可用**；**要有"真白的内容"必须带上你自己的数据**（指向桌宠数据目录即可，见 §5）——
> 它分发的是"助手能力 + 个人数据管道"，不是通用问答机器人。

---

## 1. 安装与配置

**Node.js ≥ 22**（项目最低要求）。

```bash
# npmjs 官方源
npm install -g mashiro-mcp

# GitHub Packages 镜像（国内网络优先，随 Release 自动发布）
npm install -g @idontplaygenshinimpact/mashiro-mcp --registry=https://npm.pkg.github.com/
```

**LLM Key（B 档工具必需）**——三选一：

```bash
# 方式 1：环境变量（推荐）
export DEEPSEEK_API_KEY=sk-xxx        # Linux/macOS
set DEEPSEEK_API_KEY=sk-xxx           # Windows

# 方式 2：数据目录指向已有桌宠数据（设置中心配过的 key 自动继承，见 §5）

# 方式 3：安装目录建 .env（DEEPSEEK_API_KEY=sk-xxx）
```

验证：

```bash
mashiro-mcp --version   # 或直接运行（stdio 模式，等待客户端连接）
```

## 2. 接入配置

### Claude Code（`~/.claude.json` 或项目 `.mcp.json`）

```json
{
  "mcpServers": {
    "mashiro": { "command": "mashiro-mcp" }
  }
}
```

Windows（npm 全局脚本是 `.cmd`，需经 cmd 转发）：

```json
{
  "mcpServers": {
    "mashiro": { "command": "cmd", "args": ["/c", "mashiro-mcp"] }
  }
}
```

### Cline / Cursor（MCP 配置面板）

| 字段 | 值 |
|---|---|
| 命令 | `mashiro-mcp`（Windows 用 `cmd /c mashiro-mcp`） |
| 传输 | stdio |
| 自动批准 | 建议开启只读工具（search/solve/get_* 全部只读，无写副作用） |

### OpenCode

`opencode.json` 的 `mcp` 段添加 `{ "type": "stdio", "command": "mashiro-mcp" }` 或按客户端文档配置。

## 3. 工具清单（9 个，全部只读）

| 工具 | 参数 | 用途 |
|---|---|---|
| `search_posts` | query, site? | 搜索前端/AI Agent 面经、笔试真题（牛客/掘金/CSDN），返回标题+链接 |
| `solve_question` | question, position? | 完整讲解一道面试题（结论/原理/JS 实现/边界），代码用 JS/TS |
| `get_study_plan` | — | 查看学习清单（必会/进阶/拓展分层），了解待学知识点 |
| `start_interview` | position?, role? | 开始模拟面试（技术深挖型/温和引导型/压力追问型），返回第一问+维度+合格标准 |
| `get_personal_profile` | — | 查看个人主页简历（教育/项目/技能栈/求职目标） |
| `get_jobs_status` | — | 查看校招推荐岗位/投递状态/收藏/公司统计 |
| `get_schedule_events` | — | 查看面试/笔试日程（邮箱邀约识别） |
| `get_study_progress` | — | 学习进度总览（清单/复习卡/专项/真题/专注统计） |
| `get_project_archives` | — | 查看本地项目源码档案（技术栈/目录/核心实现——来自设置中心配置的项目名=目录） |

> 全部工具**只读**：不写数据、不发起网络爬取之外的副作用（search 仅站内检索）。
> `start_interview` 会调用一次 LLM 生成首问（按配置的模型计费）。

## 4. 使用示例

装好并在 Claude Code 里连接后，直接对话：

```
用户：帮我搜一下拼多多的笔试真题，选一道讲清楚
→ 真白：search_posts("拼多多 笔试") → solve_question(...) → 给出完整讲解

用户：我学到了什么程度？还有哪些没学？
→ 真白：get_study_plan() + get_study_progress() → 汇总待学清单与进度

用户：用我的简历项目来一场模拟面试
→ 真白：get_personal_profile() + get_project_archives() → start_interview(...) → 逐轮面试
```

## 5. 数据与权限说明

- **数据目录自动探测**（`lib/data-detect.mjs`，实测有效）：启动时按优先级找"已存在的桌宠数据库"——
  源码版（项目 data/）→ 打包版桌宠（Electron userData/data）→ `~/.mashiro/data`——
  **已有桌宠数据的用户装包即连，无需任何配置**；全新用户自动创建 `~/.mashiro/data`（空结构）。
  可用 `MIANSHI_DATA_DIR` 显式覆盖。
- **LLM key 自动继承**：数据目录指向桌宠数据后，设置中心配过的 key（settings 表）自动生效
- **LLM 调用**：`solve_question`/`start_interview` 需要 key（§1）；其余工具纯本地检索零模型成本
- **只读边界**：全部工具只读个人数据，不对外传输、不写数据、无遥测

## 6. 常见问题

| 问题 | 解决 |
|---|---|
| `mashiro-mcp: command not found` | npm 全局 bin 不在 PATH（Windows 常见）——用 `npx mashiro-mcp` 或检查 npm prefix |
| Windows 下连接后无响应 | 必须 `cmd /c mashiro-mcp`（npm 全局脚本是 .cmd） |
| 报 Node 版本过低 | 升级到 Node ≥ 22 |
| 搜索返回空 | 站内检索依赖网络；确认可访问牛客/掘金 |
| 想接入其他工具 | 任何 MCP 客户端均可，配置同上（stdio 传输） |

## 7. 版本与发布

- 包名：`mashiro-mcp`（npmjs）/ `@idontplaygenshinimpact/mashiro-mcp`（GitHub Packages）
- 发布：GitHub Release 自动发布双源（workflow `release.yml`）
- 源码：`mcp-server.mjs`（MCP SDK + zod 参数校验，9 工具全部只读）
