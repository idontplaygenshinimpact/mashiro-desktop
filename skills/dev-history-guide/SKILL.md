---
name: dev-history-guide
description: 开发历史面试文档生成——基于 git 时间线 + opencode 会话 + DSH 会话生成结构化开发历史讲解文档（时间线/关键决策/技术演进/可讲亮点）。用户说"生成开发历史面试文档"、"我的开发历程怎么讲"、"这个项目开发过程"时使用
---

# dev-history-guide：开发历史面试文档

## 何时使用

用户说以下任一触发：
- "生成开发历史面试文档"
- "我的开发历程怎么讲 / 项目开发过程"
- "面试官问开发过程怎么答"

## 使用流程

1. **先读历史**：调 `read_dev_history` 拿开发时间线（git log 主源 + opencode 会话 + DSH 会话）
2. **按需深查**：`read_dev_history` 支持按 source 过滤（git/opencode/dsh）——git 看提交节奏、opencode 看会话主题、DSH 看对话过程
3. **生成文档**：调 `generate_dev_history_guide`（内部编排：git 时间线 → opencode 会话摘要 → LLM 生成 → 存档 `output/dev-history-guides/<项目名>.md`）
4. **多轮反馈**：用户对文档提意见 → 用 `read_dev_history` 查对应时段 → 修正（对话内自然完成）

## 纪律（三条红线）

- **只读**：opencode.db 以 readOnly 打开、git 只用只读命令（log/show）、不写任何历史数据（只写生成的文档到 output/）
- **不读凭据**：opencode 只查 session/message/part 表（credential/account/control_account 表一律不碰）；DSH 只读 sessions/ 下的会话文件（`.credentials.yaml` 等凭据文件不读）
- **截断诚实**：大会话/大结果返回 `truncated: true` 标记（复用 project-guide 的覆盖范围透明模式）——文档末尾标注覆盖范围（完整/部分/未覆盖）
