# Web 任务成功率评测（WebArena 风格）

固定的真实世界任务，用**真实 LLM + 真实网络**端到端跑一遍 agent，只验证**最终产物**，不看过程。

- 与 `benchmark.mjs`（Layer A，模型基线）的区别：那层测「模型 + prompt」的讲解质量；本层测 agent 在真实世界里完成一个完整任务的成功率。
- 与 `benchmark-agent.mjs`（Layer B，mock LLM）的区别：那层 mock 掉 LLM/网络、测 harness 机制；本层是真金白银的端到端成功率。
- **判定只看产物**：agent 最终说了什么（回复文本）、在 `output/` 里留下了什么归档文件。不检查它调了哪些工具。

## 任务集

10 个任务，三档难度（`benchmark/web-tasks/tasks.json`）：

| 档位 | 数量 | 典型链路 | 判定方式 |
|---|---|---|---|
| easy | 3 | Bing `web_search` + 总结 | `answer_contains`：回复命中关键词 |
| medium | 4 | `search_posts` → `fetch_page` → `solve_question` | `solved_question` / `output_file`：output 新文件 |
| hard | 3 | 多步 search → fetch → solve → 校验 | `solved_question`（含 minFiles≥2 的严格项） |

任务字段：`{ id, name, prompt, difficulty, judge: {type, minFiles?, requiredKeywords?}, timeoutMs }`。

判定类型：

- `answer_contains`：回复文本需命中**全部** `requiredKeywords`。
- `output_file`：`output/` 出现新文件，且文件名或内容命中**任意一个** `requiredKeyword`，数量 ≥ `minFiles`（默认 1）。
- `solved_question`：`output/` 新文件内容含「结论」+「原理」，且命中**任意一个** `requiredKeyword`，数量 ≥ `minFiles`。

## 运行

```bash
# 跑全部 10 个任务（真实消耗 LLM token + 抓取网页）
node scripts/web-task-bench.mjs

# 只跑某个任务
node scripts/web-task-bench.mjs --task easy-react19

# 只跑前 N 个任务（先按 --task 过滤）
node scripts/web-task-bench.mjs --limit 3

# 校验 schema + 打印执行计划（不调 LLM/网络，CI 安全，无需 API key）
node scripts/web-task-bench.mjs --dry-run

# 不写报告文件
node scripts/web-task-bench.mjs --no-save
```

也提供 npm script：`npm run bench:web`。

前置：`.env` 里配好 `DEEPSEEK_API_KEY`（或环境变量 / opencode 复用 key）。没 key 会 fail-fast 报错并提示；`--dry-run` 不需要 key。

## 分数含义

- 每个任务 0/1：`pass=1` 表示 agent 产出了满足判定要求的最终产物，否则 `pass=0` 并带 `failureCategory`。
- 汇总：`passRate`（通过率）+ 失败分类计数 + 平均耗时。

失败分类：

| failureCategory | 含义 |
|---|---|
| `timeout` | 超过任务 `timeoutMs` 仍未返回 |
| `network_error` | harness 层网络类错误（LLM/抓取链路全挂） |
| `no_artifact` | 什么都没产出（无回复 / 无新输出文件） |
| `partial_artifact` | 有产出但不完整（回复过短 / 命中文件数 < minFiles） |
| `wrong_content` | 产物齐全但内容不符关键词/格式 |

报告写 `benchmark/reports/web-tasks-<timestamp>.json`（及 `web-tasks-latest.json`），含每个任务的 `pass / durationMs / artifactPath / evidence / failureCategory`。

## 添加新任务

编辑 `benchmark/web-tasks/tasks.json` 的 `tasks` 数组，加一条：

```json
{
  "id": "easy-xxx",
  "name": "一句话描述",
  "difficulty": "easy",
  "prompt": "给 agent 的自然语言指令（中文）",
  "judge": { "type": "answer_contains", "requiredKeywords": ["关键词1", "关键词2"] },
  "timeoutMs": 600000
}
```

- `judge.type` 三选一，按「最终产物是什么」选：回复里的结论 → `answer_contains`；要它归档文件 → `output_file`；要它完整讲解（结论/原理格式）→ `solved_question`。
- `requiredKeywords` 挑**几乎必然出现**的主题词（太冷门的关键词会误伤）。`answer_contains` 是 AND，file 类是 OR。
- 改完先 `node scripts/web-task-bench.mjs --dry-run` 校验 schema。

## 成本与时间警告

⚠️ **本评测真实消耗 LLM token + 真实抓取网页**：

- 每个任务会触发多次 LLM 调用（agent 工具循环）和多次 Playwright 抓取，hard 任务还可能调用 `solve_question`（单次约 2.4 万 tokens）。
- 全部 10 个任务一次跑下来预计 5–15 分钟，token 成本随模型/任务波动。
- 建议：日常回归用 `--task` 跑单任务、`--limit` 跑前几个；全量只在需要完整成功率报告时跑。

## 实现要点

- **产物判定**：跑任务前后对 `output/` 做快照 diff，找出新文件再读内容判定（`solve_question` 归档到 `output/chat_solutions/`）。
- **DB/MCP 隔离**：复用 `tests/helpers.mjs` 的 `setupTempDb`，跑在临时 SQLite 上，不污染真实 `mianshi.db`、不连真实 MCP server。
- **headless 审批**：`solve_question` 属 confirm 级工具（deny-first 权限），评测里自动批准（`resolveApproval`），模拟用户点允许。
- **任务隔离**：每次 `chatWithAgent` 传显式空历史，避免持久化对话历史跨任务污染。
