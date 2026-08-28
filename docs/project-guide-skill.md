# project-guide 可移植 skill 包 + MCP 桥接（v2 追加）

> 项目面试讲解指南能力的三条分发路径：**skill 包**（纯提示词，任何 agent 可加载）→ **MCP 工具**（任何 MCP 客户端可调）→ **内置 skill**（桌宠 agent 原生）。

## 一、可移植 skill 包（`project-guide-skill/`）

纯提示词零依赖，两个文件：

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 触发时机 + 使用流程 + 纪律（frontmatter 声明式） |
| `guide-template.md` | 7 段模板（定位/选型/架构/亮点/问题清单/防御/简历 bullet）——把档案+源码摘录填入【材料】即可用 |

**单一来源**：桌宠内置 skill（`skills/project-guide/skill.mjs`）运行时读取此模板文件——改模板即改行为，无代码重复。

## 二、各成熟 agent 加载方式

### Claude Code（skills）

```bash
# 项目级（推荐，随仓库分发）
mkdir -p .claude/skills/project-guide
cp project-guide-skill/SKILL.md project-guide-skill/guide-template.md .claude/skills/project-guide/

# 或用户级（全局可用）
mkdir -p ~/.claude/skills/project-guide
cp project-guide-skill/* ~/.claude/skills/project-guide/
```

Claude Code 自动发现 skills 目录，`/skill` 或对话触发。注意：Claude Code 的 skill 是**提示词驱动**（无代码工具）——读源码靠 Claude Code 自身的文件读取能力，模板的【材料】由 agent 自行填充。

### DeepSeek Harness（DSH skills）

```bash
# 放入 DSH 的 skills 目录（按 DSH 文档的 skills 约定）
cp -r project-guide-skill/ <dsh-skills-dir>/project-guide/
```

### Codex（AGENTS.md）

```markdown
<!-- 在 AGENTS.md 中引用 -->
## 项目面试讲解指南

当用户要求"生成 XX 项目的面试讲解指南"时：
1. 读取项目档案（package.json/README/核心模块）
2. 按 `project-guide-skill/guide-template.md` 的 7 段模板生成
3. 只基于真实源码，档案里没有的不许编造
```

## 三、MCP 桥接（外部 agent 直接调工具）

`mashiro-mcp` 包新增 2 个工具（复用内置 skill 实现，含路径白名单/50KB 上限/map-reduce）：

| 工具 | 入参 | 说明 |
|---|---|---|
| `generate_project_guide` | project | 生成 7 段指南并存档（subagent 并行深读 + 覆盖范围透明） |
| `read_project_file` | project, file, mode? | 白名单项目内读源码（head/export/full 三档） |

```bash
npm i -g mashiro-mcp   # 发布包已含 skills/project-guide/ + project-guide-skill/
```

Claude Code 配置后直接对话："生成 mashiro-desktop 的面试讲解指南" → 调 `generate_project_guide` → 返回指南路径 + 覆盖范围。

## 四、三条路径对比

| 路径 | 依赖 | 能力 | 适用 |
|---|---|---|---|
| skill 包（纯提示词） | 无（任何 LLM） | 7 段模板 + 纪律 | 任何 agent 快速接入 |
| MCP 工具 | mashiro-mcp 包 | 完整实现（白名单/并行/覆盖透明） | Claude Code/Cline/Cursor 等 MCP 客户端 |
| 内置 skill | 桌宠 | 完整实现 + 多轮反馈 | 桌宠对话 |
