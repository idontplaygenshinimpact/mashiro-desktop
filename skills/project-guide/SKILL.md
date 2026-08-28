---
name: project-guide
description: 项目面试讲解指南生成——基于真实源码生成 7 段结构化讲解指南（定位/选型/架构/亮点/问题清单/防御/简历 bullet）。用户说"生成 XX 项目的面试讲解指南"、"我的项目怎么讲"、"帮我准备项目介绍"时使用
---

# project-guide：项目面试讲解指南

## 何时使用

用户说以下任一触发：
- "生成 XX 项目的面试讲解指南"
- "我的项目怎么讲 / 帮我准备项目介绍"
- "这个项目面试官会问什么"

## 使用流程

1. **先拿档案**：调 `get_project_archives`（或 `getProjectArchive`）拿项目档案（技术栈/结构树/README/核心预览）——确认项目在 `personal_projects` 配置里
2. **按需读源码**：用 `skill__project_guide__read_project_file` 读 2-5 个关键文件（package.json 确认技术栈、README 确认定位、核心模块确认实现）——**只读档案和源码里有的内容**
3. **生成指南**：调 `skill__project_guide__generate_project_guide`（内部按 7 段模板生成并存档到 `output/project-guides/<项目名>.md`）
4. **多轮反馈**：用户对指南提意见 → 用 `read_project_file` 读对应源码 → 修正（对话内自然完成）

## 纪律

- **只基于档案 + 真实源码生成**——档案/源码里没有的不许编（防幻觉技术栈/功能）
- 读文件只读已配置项目目录内（路径白名单，防穿越）
- 单文件 >50KB 拒绝（防灌爆上下文）
