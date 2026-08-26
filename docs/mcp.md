# Mashiro MCP 分发文档（npm 包使用指南）

> 真白秋招助手是标准 **MCP Server**：`npm i -g mashiro-mcp` 后，任何支持 MCP 的 AI 工具
> （Claude Code / Cline / Cursor / OpenCode）都能调用真白的能力——不需要桌宠、不需要本项目代码。

---

## 1. 安装

**Node.js ≥ 22**（项目最低要求）。

```bash
# npmjs 官方源
npm install -g mashiro-mcp

# GitHub Packages 镜像（国内网络优先，随 Release 自动发布）
npm install -g @idontplaygenshinimpact/mashiro-mcp --registry=https://npm.pkg.github.com/
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

- **数据来源**：本地 `~/.mashiro/`（或项目 `data/`）目录下的个人数据（简历/清单/投递/日程）——
  MCP 只读这些数据，不对外传输
- **模型调用**：`start_interview`/`solve_question` 需要 LLM（环境变量 `DEEPSEEK_API_KEY` 或
  面板设置里的 key）；其余工具纯本地检索零模型成本
- **无遥测**：不收集使用数据；日志仅本地

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
