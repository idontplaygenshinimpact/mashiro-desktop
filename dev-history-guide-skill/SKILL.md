---
name: dev-history-guide
description: 开发历史面试文档生成——基于 git 时间线 + opencode/DSH 开发会话，生成结构化面试文档（时间线/关键决策/技术拷打点/八股/踩坑）。用户说"生成开发历史面试文档"、"这个项目开发过程有什么坑"、"开发选型为什么这么定"时使用
---

# dev-history-guide：开发历史面试文档（可移植 skill 包）

> 纯提示词零依赖——任何 agent（Claude Code / Codex / DSH / OpenCode）加载后用自己的能力执行。
> 数据源：git 历史（时间线）+ opencode 会话库（开发过程记录）+ DSH 会话（补充）。

## 何时使用

- "生成开发历史面试文档"
- "这个项目开发过程有什么坑 / 关键决策是什么"
- "为什么选这个技术 / 当时怎么定的"

## 使用流程

1. **git 时间线**：`git log --oneline --format='%h %ad %s' --date=short`（或等价只读命令）——还原开发阶段/里程碑
2. **opencode 会话**：读 `~/.local/share/opencode/opencode.db`（SQLite，readOnly）——session/message/part 表，提炼开发过程的问题/决策/选型
3. **DSH 会话**：读 `~/.dsh/sessions/`（如为压缩格式，解压后读元数据；消息不在文件内时诚实标注"元数据级"）
4. **生成文档**：按下方模板生成 → 存档 `output/dev-history-guides/开发历史面试文档.md`
5. **多轮反馈**：用户指定阶段/主题 → 读对应历史 → 补充

## 三条红线（必须遵守）

1. **只读**：opencode.db 用 readOnly 打开；git 只用 log/status 类只读命令；不写任何历史数据（只写文档到 output/）
2. **不读凭据**：opencode 只查 session/message/part 表（credential/account 表不碰）；DSH 不读 `.credentials.yaml` / auth.json
3. **截断诚实**：大会话/大结果返回 truncated 标记；文档末尾标注覆盖范围（完整/部分/未覆盖）

## 文档模板（5 段）

见 `guide-template.md`——时间线 / 关键决策（含"为什么"）/ 技术拷打点（含文件:行号）/ 相关八股（含"本项目怎么用"）/ 踩坑清单。
