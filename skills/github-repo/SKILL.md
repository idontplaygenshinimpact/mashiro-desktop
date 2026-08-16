---
name: github-repo
description: 查询 GitHub 公开仓库信息（星标/语言/描述/更新时间），了解开源项目与框架动态
---

# GitHub 仓库信息查询

当用户询问某个开源项目/框架的仓库情况（多火、多星、最近更新、用什么语言）时，调用
`skill__github-repo__get_repo_info` 工具。

- repo 参数格式：`owner/repo`，如 `vuejs/core`、`facebook/react`
- 返回：stars / forks / openIssues / language / license / description / updatedAt
- 只读公开数据，无需审批；GitHub API 限流时如实返回错误，不要编造数据
