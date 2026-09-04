# Phase 评测：评测体系扩容 + 消融基线 技术方案

> 目标：把现有"设计强、规模小"的双层评测，升级成"规模够、指标全、能回归、有基线、看得见"的体系，并产出可写进简历的真实 Δ 数字。
> 配套：docs/AI评测体系包装与升级.md（现状盘点与理由）；本文档是落地方案。

---

## 1. 现状盘点（已逐文件核实）

| 项 | 现状 | 证据 |
|---|---|---|
| Layer A 真实模型 | 讲解质量（客观代码验证 + LLM-as-Judge 四维双评）+ TRACe 材料题 + classify/detect/静态 + CRAG 真实判官 + 判官金标校验（judge-check） | benchmark.mjs（:456 综合分 = solve*0.5+classify*0.15+detect*0.2+static*0.15） |
| 数据集规模 | questions **38**（code4/coverage5/predict1/trace4）、classify **8**、detect **6**、静态 6（硬编码）、judge-gold **10**、web-tasks **1** | benchmark/*.json |
| Layer B mock | 10 legacy + 3 面试场景，pass^k、goalState、taxonomy；CI 已接（pass1 全过才绿） | benchmark-agent.mjs、ci.yml |
| 指标缺口 | 无成本/延迟、无 pass@k、无 EM、无回归对比、无趋势 | 报告只有 json 堆在 reports/ |
| ⚠️ 关键事实（已核实） | **讲解链路刻意不用 RAG**（主动决策，非缺失）；**RAG 按任务分流保留**：出题/刷题/agent 搜索仍用 `searchKnowledge`，且 agent.mjs 有 `ragEnabled` 开关 | lib/ai.mjs:401-447；lib/interview.mjs:119、lib/quiz.mjs:61、lib/agent.mjs:254 |
| ✅ 成本数据已可拿 | trace_llm 表存 input/output_tokens + duration_ms + model + ok | lib/trace.mjs:7-14（评测用 setupTempDb 隔离，读临时库即可） |

---

## 2. 范围（4 个交付物）

1. **评测集扩容 + 格式统一 + 数据合法性校验**（规模够、可追溯）
2. **指标层：正式口径 + 成本/延迟 + 回归对比与分层门禁**
3. **消融基线 A/B**（诚实版：prompt 工程消融，非 RAG）——产出 Δ 数字
4. **可视化 + CI 接入 + 可复现性**（徽章/趋势/每周定时）

---

## 3. 交付物一：评测集扩容与统一

### 3.1 统一数据格式（所有数据集同一 envelope）
```jsonc
{
  "version": 2,
  "meta": { "generatedBy": "script/人工", "updatedAt": "ISO", "note": "" },
  "cases": [
    { "id": "q001", "type": "code", "title": "事件循环输出顺序", "question": "...",
      "must_cover": ["宏任务","微任务"], "test": "...", "source": "2026-08-01/01_百度面经.md" /* 每样本可追溯 */ }
  ]
}
```
- **`source` 强制必填**（来源可追溯 = 面试被问"样本哪来的"能答）
- classify/detect/judge-gold/trace 题同样并入 `cases` 结构（兼容现有字段，只新增 source/meta）
- 迁移方式：**不破坏现字段名**，只加 `version/meta/source`——老解析代码（benchmark.mjs 的 `load()`）读兼容。

### 3.2 数据合法性校验器（新）
`scripts/validate-evaldata.mjs`：
- 校验每个病例 schema（缺 id/source/type 必报）、type 枚举合法、must_cover 非空、judge-gold 的 gold 标签枚举正确
- 计算 **datasetHash**（对 cases 序列化 + version 做 sha256）→ 报告里写入，回归对比按同 hash 才可比
- 退出码：发现脏数据 exit 1（进 CI）
- 配套 `tests/validate-evaldata.test.mjs`（校验器自测 + 对 5 个数据集文件跑合法性）

### 3.3 扩容目标与来源（具体到文件）
| 数据集 | 现状 → 目标 | 来源 |
|---|---|---|
| questions.json | 14 → **60+**（code/predict/coverage/trace 四型比例保持） | `data/`、`lib/quiz.mjs` 题库、`output/` 面经提炼、`lib/ai-career.mjs` challenges |
| classify.json | 8 → **40+**（含对抗样本：疑似题面/非题面） | 真实版面 + 反例构造 |
| detect.json | 6 → **30+** | 含无题面文本负例 |
| judge-gold.json | 10 → **30+**（故意错误答案 incorrect≥5、避答 missing≥6，保证金标分布） | 人工标注，带 source 备注 |
| web-tasks.json | **1** → **20+**（answer_contains / output_file / solved_question 三类） | WebArena 思路构造，每条带 requiredKeywords + 判定类型 |
| 静态用例 | 6（代码硬编码）→ 移入 `benchmark/static.json` 并扩到 **12+** | 消除"硬编码用例不透明"的质疑 |

扩容原则：**新增样本全部可追溯 + 校验器保证不入脏**；不追求"数量惊人"，60 题分四型合理覆盖即可，重点是"来源可讲 + 结构规范"。

---

## 4. 交付物二：指标层与回归门禁

### 4.1 新增指标（在现有报告基础上加字段）
- **pass@1 / pass@3**（Layer A：默认 pass@1 单跑；`--repeat 3` 时算 pass@3，与 Layer B 口径对齐）
- **EM**（predict 题精确匹配率，已有 stdout 比对逻辑，补 EM 聚合）
- **成本**：评测期 LLM 调用计数（新 `lib/eval-cost.mjs`：`startEval()` 后在 llmChat 外层包一层，按用途 tag 记 tokens/ms，**本地计数器而非解析 trace_llm**，更干净）；输出总 tokens、估算成本（按单价常量可配）、**solver vs judge 分账**
- **延迟**：每调用 duration_ms → P50/P95
- **失败分类**（对齐 Layer B 的 taxonomy 思路）：空响应 / 代码验证失败 / judge 降级 / truth 判官失败 / 抛错
- 判官 inter-agreement（已有 judge-check，保留并纳入 summary）

### 4.2 summary 统一落盘（回归对比的数据底座）
`benchmark/reports/eval_summary.csv`（追加行，列）：
```
ts, layer(A|B|web), mode(quick|full), datasetHash, llmModel, composite,
solveScore, truthfulness, classifyRate, detectRate, staticRate, traceScore,
costTokens, costUsd, p50Ms, p95Ms, pass1, failCount, exitCode
```
- **llmModel 从配置读**（config.mjs model/officialModel），固定 temperature（judge 0.2 / solver 0.5 现状已固定，写入文档）
- Layer B（mock）也写一行（成本 0、确定值），保留全貌

### 4.3 回归对比 + 分层门禁（新脚本 `scripts/bench-compare.mjs`）
- 读 `eval_summary.csv`，找**同 layer ∧ 同 datasetHash** 的最近两次，输出 Δ 表（composite/各维/成本/延迟）
- **分层门禁（诚实设计，避免小样本误杀）**：
  - 硬红（exit 1）：`classify/detect/static` 任一降 >3%（确定性高、样本大，用于硬门禁）
  - 黄牌（exit 0 + 打印⚠️）：`solveScore/truthfulness` 降 3~5%（波动大，需连续 2 次同向才升级红——实现为读取两份历史判断）
  - 提交 `comparison` 字段进报告；CI 用 `--gate` 参数决定是否 exit
- 数据集变更（hash 不同）时**不跨集对比**，只打印"数据集已变更"，避免拿不同样本数当回归

---

## 5. 交付物三：消融基线 A/B（诚实版）

### 5.1 消融对象修正 + 设计决策档案（已核实）
事实：本项目**讲解链路（solveQuestionImpl）刻意不用 RAG**——这是主动工程决策，不是缺失：
- **黑箱 vs 可解释**：RAG 检索来源不可见；讲解要求"每一点可讲出来源"，grep 级检索返回"命中行 + 来源"可控可回溯
- **任务匹配**：讲解是"把已知讲清楚"（固有知识 + 结构化输出足够），不是"检索罕见事实"（那才是 RAG 主场）
- **成本**：向量索引/Embedding 的复杂度与开销，对讲解收益不达
- **RAG 并未被弃用，而是按任务分流**：出题/刷题/agent 搜索仍用 `searchKnowledge`（agent.mjs 有 `ragEnabled` 开关）——**决策粒度是"每个环节自己选"，不是全有或全无**

消融主线（写数值，讲解链路）：
```
基线 A：裸 prompt —— 一句话"讲一讲这道题" + 题目（无系统人格、无结构模板、无 sanitize/来源约束）
全链路 B：现有 solveQuestionImpl（career 人格化 + 结论/原理/实现/边界 结构模板 + UNTRUSTED 声明 + 频率约束）
```
目的：量化"prompt 工程 + 结构化模板"的价值（讲解链路的真实改进源）。

**消融 2（可选，建议做：把"弃用 RAG"从主观变有数）**：讲解链路 **RAG on vs off** 同题 A/B（`searchKnowledge` 拉上下文 vs 不加）：
- 预期（依据上述决策理由）：无显著增益或稳定性更差（抖动大、来源不可见）→ "弃用 RAG"获实测支撑
- 若反直觉（RAG 确实提升）→ 诚实修正决策（说明值得引入）——这才是工程决策该有的样子
- 成本：`--sample 15`，可控；结果写进决策档案

**决策档案文档化**：评测 README（W4 建）加一节「为什么讲解链路不用 RAG」——面试/简历直接引用，是把"黑箱 vs 可解释、按任务分流"讲成工程判断的资产。

### 5.2 实现（不侵入生产代码）
- 新 `scripts/bench-ablation.mjs`：
  - 基线 solver 内联定义（调 `llm.mjs` 的 llmChat，裸 prompt，temperature 与 B 一致 0.5）
  - 全链路 solver = `import { solveQuestion } from lib/ai.mjs`
  - 同一题 A/B **随机顺序**跑（消除判官顺序偏差）
  - 各用现有评分栈：Judge 双评 + CRAG 真实判官 + must_cover 覆盖度（复用 benchmark.mjs 的 judgeAnswer/judgeTruthfulness/evalQuestion 逻辑——抽出共享）
  - `--sample N`（默认 20）控成本；每样本独立临时库（setupTempDb）护生产数据
- 输出 `benchmark/reports/ablation-<ts>.json`：`{ datasetHash, a:{solve,truth}, b:{solve,truth}, delta:{solveΔ, truthΔ, coverΔ, costΔ} }`

### 5.3 拿 Δ 数字（写简历用）
- 跑完输出人话一行：`全链路 vs 裸 prompt：讲解均分 61→81（+33%），CRAG correct 40%→82%，覆盖度 +25pt`（数值以实测为准）
- **铁律**：数值只写实测，实验挂掉就如实标注"未跑出"；不预填

---

## 6. 交付物四：可视化 + CI + 可复现

### 6.1 可视化（无前端依赖）
- `scripts/gen-bench-report.mjs` 读 `eval_summary.csv`：
  - 生成 README 评测徽章片段（`[Eval: 82/100 · CRAG 82% · 分类 93%]` 文本 + shields.io 动态 badge URL），输出 markdown 片段 + 提交进 repo
  - 生成 `benchmark/trend.svg`（纯字符串拼折线，零依赖）——最近 8 次 composite/truth 趋势
- README 增补"评测"章节（双层说明 + 徽章 + 复现命令 + 最近 Δ 表）

### 6.2 CI 接入（分层，预算诚实）
| 项 | 触发 | 成本（估） | 说明 |
|---|---|---|---|
| `validate-evaldata` + 数据集合法性 | 每次 push/PR | 0 | 数据出问题 CI 直接拦 |
| `bench:agent`（已有） | 每次 push/PR | 0 | mock 确定性，硬门禁保留 |
| **`bench:judge`（--judge-check，30 金标×2）** | 每次 push/PR | ~60 次调用，<¥0.1 | 判官可靠性常驻校验（评分的评分） |
| `bench:quick`（2 题+1 材料） | 每次 push/PR | ~15 次调用 | 需 DEEPSEEK_API_KEY secret 才启用（无 key 则跳过，不红） |
| `bench:full` + web + ablation | 每周 schedule（新 `weekly-eval.yml`） | 全量 ~310 次 + web 20，单周可控 | 归档报告；失败发 issue/注释（用 GITHUB_TOKEN + problem comment） |
| `bench-compare --gate` | weekly 之后 | 0 | 分层门禁（见 4.3），红则 weekly job 失败留痕 |

- **secret 策略**：`DEEPSEEK_API_KEY` 加为 repo 级 secret；quick/judge 步骤 `if` 判断 key 存在才跑，不存在自动 skip（不拖垮 CI）
- 本地 `npm run bench`（默认 full）视为"开发期手动全量"，可加 `-n` 子集参数

### 6.3 可复现性
- 报告统一写 `model / datasetHash / node 版本 / temperature / 模式` 于 envelope
- 评测脚本固定 seed（judge 已 temperature 0.2；solver 0.5），不固定则记录说明
- mock 层（Layer B）与真实层（Layer A）在报告 `/env.mocked` 标注，双轨清晰

---

## 7. 文件清单

**新增**
- `scripts/validate-evaldata.mjs`、`tests/validate-evaldata.test.mjs`
- `lib/eval-cost.mjs`（评测期 LLM 计数 helper）
- `scripts/bench-ablation.mjs`（消融 A/B）
- `scripts/bench-compare.mjs`（回归对比 + 分层门禁）
- `scripts/gen-bench-report.mjs`（徽章 + 趋势 svg）
- `benchmark/static.json`（静态用例移出代码）
- `.github/workflows/weekly-eval.yml`

**修改**
- `benchmark/questions|classify|detect|judge-gold.json`：加 version/meta/source + 扩容（增量合入，逐文件负责人即改脚本的人）
- `benchmark/web-tasks/tasks.json`：1 → 20+
- `scripts/benchmark.mjs`：指标字段 + eval_summary.csv 写入 + datasetHash + envelope 统一 + 复用评分栈导出（供 ablation）
- `scripts/web-task-bench.mjs` / `benchmark-agent.mjs`：写 eval_summary.csv 行
- `.github/workflows/ci.yml`：加 validate + judge-check（可选 key 门控）
- `package.json`：新增 scripts（bench:validate / bench:judge / bench:ablation / bench:compare / bench:report）
- `README.md`：评测徽章 + 章节

---

## 8. 验收标准（可测）

1. `npm run bench:validate` 全绿；故意塞一个坏样本（缺 source）→ exit 1（证明校验器生效）
2. `npm run bench -- --quick` 跑通并写 `eval_summary.csv`（含 costTokens/p50/p95/pass1 + datasetHash）
3. `npm run bench:compare` 对最近两次输出 Δ 表；手工改 classify 数据使其降 5% → 同 hash 下 exit 1（证明门禁生效）
4. `npm run bench:ablation -- --sample 20` 输出 A/B Δ 表（真实数值，不预填）
5. `gen-bench-report` 生成可提交的 README 徽章 + trend.svg
6. CI：无 key 时 quick/judge 自动 skip 不红；有 key 时跑通；weekly workflow 触发正常（可手动 `workflow_dispatch` 验证）
7. 所有新旧报告均含 envelope（model/hash/mode），`benchmark/reports/` 结构统一

---

## 9. 工作量与 Wave

| Wave | 内容 | 工作量 |
|---|---|---|
| W1 | 数据格式统一 + validate 校验器 + 静态用例迁移；**逃逸：不跑 LLM**，纯脚本+测试 | 1 天 |
| W2 | 指标层（eval-cost 计数 + summary.csv + envelope）+ bench-compare 分层门禁 | 1~1.5 天 |
| W3 | 消融 bench-ablation（复用评分栈，--sample）→ **跑一次拿真实 Δ** | 1.5~2 天 |
| W4 | 可视化（徽章/trend.svg）+ CI/weekly 接入 + README 章节 + 数据扩容落地（60/40/30/30/20） | 1.5~2 天 |
| 全量扩容 | 样本库积累（来源可追溯），与 W1-W4 并行渐进，不阻塞 | 1~2 周内随用随补 |

---

## 10. 诚实提醒（写简历前必读）

- 消融主线数字 = **prompt 工程消融**（讲解链路的真实改进源），简历写"结构化 prompt 使讲解均分 +X"，**不写"引入 RAG 提升讲解"**
- 若做了消融 2 且实测无增益，可写：**"经同题 A/B 实测，讲解链路刻意不引入 RAG（黑箱、不可解释、无增益），采用结构化 prompt + 模型固有知识 + 可回溯检索；RAG 按任务分流保留于出题/刷题/agent 搜索"**——这是有数据支撑的决策，且体现"按环节选型"的完整架构，比"堆 RAG"高级得多
- 若消融 2 结果反直觉（RAG 有提升）：如实修正决策（承认并考虑引入），**不要为了叙事掩盖实验**
- 门禁分层不是"让 CI 变红"的手段，是让小样本波动不误杀、同 hash 才可比——面试被问"样本这么少怎么统计"就直接答"分层门禁 + 同哈希才比 + 连续两次才升级"
- 指标是"能讲机制的工程资产"：成本分账（solver vs judge）值得专门讲——证明你清楚评测自己花钱花在哪

