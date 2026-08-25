# AI 评测体系：诚实盘点 + 升级到"经得起追问"的方案

> 背景：简历包装提到"AI 评测体系（mock-LLM 基准门禁）"，被质疑简陋、一问就露馅。
> 结论先行：**评测方法论是专业的，规模是寒酸的**。底子能吹，但要先补规模/指标/门禁/可视化，否则面试官三个问题（任务集多大？真实模型测过吗、通过率多少？跟什么比的？）就会露馅。

---

## 一、真实现状（已逐文件核实）

### 现有四套评测，实际是"双层 + 两个外挂"

| 评测 | 层级 | 用什么 | 测什么 | 规模（实测） | 是否进 CI |
|---|---|---|---|---|---|
| `benchmark.mjs`（bench:bench） | **Layer A 真实模型端到端** | 真实 LLM API | 讲解质量：客观代码验证 + LLM-as-Judge 四维评分 + once覆盖率；TRACe 材料题 rel/util/adh/comp；页面分类 / 题目检测；知识点静态匹配；**CRAG 事实核查**；**判官金标校验** | questions **14 题**（code4/coverage5/predict1/trace4）+ classify 8 + detect 6 + 静态 6 + **judge-gold 10 组** | ❌ 否（本地/手动） |
| `benchmark-agent.mjs`（bench:agent） | **Layer B mock harness 机制** | mock LLM 固定响应 | 工具循环/参数校验/容错/压缩/记忆闭环/搜索过滤/浏览器故障注入 + 面试官多轮场景；**pass^k 一致性**（每场景独立临时库子进程）、**goalState 状态断言**、**taxonomy 失败分类** | legacy 10 场景 + 面试模拟 3 场景 | ✅ 是（CI 门禁，pass1 全过才绿） |
| `web-task-bench.mjs`（bench:web） | WebArena 风格端到端 | 真实 LLM + 真实网络 | 只验最终产物（回复/归档文件），不看工具路径 | **tasks.json 只有 1 个任务** ❌ | ❌ |
| `web-agent-bench.mjs` | 上网链路（搜索/抓取/提取） | 真实 LLM | 工具链调用 + 输出长度/关键词正则 | 3~5 个小任务，判定粗糙 | ❌ |

### 强度盘点

**强（超出大多数作品集，可直接吹）**：
- 双层设计正确：Layer B 确定性零成本、mock 后结果与模型无关（可复现）；Layer A 覆盖"真实能力 + 真实性 + 材料利用"
- **判官金标校验（--judge-check）**：用 10 组人工金标测 LLM-as-Judge 自己的准确率，精确一致 <70% 报警——这是连很多团队都不做的一步，非常能打
- **objective 优先**：code/predict 题跑真实 Node 子进程验证 PASS/stdout 比对，不依赖判官——"客观判定为权威，判官只做辅助"
- pass^k 一致性 + 独立临时库 + goalState 状态断言 + taxonomy——都是正经评测基建

**弱（= 面试露馅点，要补）**：
1. **规模太小**：14 题 / WebArena 只有 1 任务。业界参考：MMLU 1.4万+ 题、GSM8K ~8.5千、WebArena 812、AgentBench 10 大环境。面试官听到"14 题"会立刻质疑统计显著性
2. **真实模型评测没进 CI**：CI 只跑 Layer B（机制），Layer A 质量没人看门；且无"跟上次构建对比"的回归报告
3. **无正式指标口径**：没有 pass@1/pass@k、EM/MRR、成本/令牌/延迟 P50/P95、置信区间；sample 小波动大却没统计处理
4. **无基线对照**：没跟"无 RAG / 无 prompt 模板"的粗方案对比过，无法回答"你评测体系证明了你什么"——这是最可惜的，Judge/TRACe 都建好了，缺一个对比实验
5. **无可视化/持续跟踪**：报告是 `benchmark/reports/*.json` 堆文件，没有趋势图、没有 README badge、没有"上一版 vs 这一版"diff
6. **两个 web 评测过粗**：web-agent-bench 用"长度>50+正则"判过；web-task-bench 只有 1 个任务

---

## 二、升级方案（4 周，照做后每一项都能被追问且答得上来）

### 第 1 周：评测集扩容（把"14 题"变成"上百样本"）

| 数据集 | 现状 | 目标 | 素材来源 |
|---|---|---|---|
| questions.json | 14 | **60+** | `data/`、`lib/quiz.mjs` 题库、`output/` 面经提炼、按 code/coverage/predict/trace 四型补 |
| classify.json | 8 | **40+** | 真实版面样本 + 对抗样本（疑似题面/非题面），标注来源可查 |
| detect.json | 6 | **30+** | 同上 |
| judge-gold.json | 10 | **30+** | 含故意错误答案（incorrect）/避而不答（missing）各 5+，保证金标分布 |
| agent-scenarios | 3 | **15+** | 面试官多轮（开场/项目拷打/追问/收官/提前结束边界） |
| web-tasks.json | **1** | **20+** | 按 WebArena 思路：搜索/抓取/提取/综合四类，每条带 requiredKeywords + 判定类型 |

每个样本必须有 `source` 字段（来自哪条面经/哪个题库），面试被问"样本哪来的"能答"来源可追溯"。

### 第 2 周：正式指标口径 + 回归门禁

- 新增指标输出：`pass@1 / pass@3`、`EM`（predict 精确匹配率）、`成本（令牌/题）`、`延迟 P50/P95`、`判官 inter-agreement`（已有）、失败分类占比（已有 taxonomy）——每条都进报告 JSON
- **最简回归门禁**：报告落库 `benchmark/reports/summary.csv`（时间戳 + 各维度均分），每次跑完与上一版 diff，输出 `Δ`：
  - 讲解均分 / CRAG 真实性 / 分类准确率 / web 成功率 出现**硬性下滑（如 < -5%）** → exit non-zero，CI 红
  - 轻微下滑 → 写进 diff 报告，PR comment 提示
- **真实模型进 CI 的最小化**：Layer A 用 `--quick`（2 题 + 1 材料题，几百 token 成本极低）+ `--judge-check` 每次 CI 跑；full 评测定时（GitHub Actions `schedule`，每周）跑并归档
- **可复现性**：评测统一固定 `temperature`、记录模型/版本号/dataset hash 进报告；mock 与非 mock 双轨标注

### 第 3 周：基线对照（最有说服力的一件事）

做一轮**消融对比**（A/B，各跑同集，固定 seed）：
- 基线 A：无 RAG、纯 prompt 空模板回答同 14→60 题
- 当前 B：全链路（RAG + prompt 模板 + 知识库 + 追问）
- 输出：讲解均分 / CRAG 真实性 / EM / 成本 的 Δ 表
- 这就是面试最硬的 talking point："基准讲解均分 61 → 引入 RAG+模板后 81，真实性 correct 占比 40%→82%"（数值以实测为准）

### 第 4 周：可视化 + 文档化（让评测"看得见"）

- `benchmark/README.md`：评测体系架构图（双层 + 判官 + 金标流程）、指标定义、复现命令
- README 顶部加评测徽章：`[e2e 最后一跑] 讲解均分 81/100 · CRAG 82% · 分类 92%`（由一个报告的 markdown 生成器产出，提交进 repo）
- 简单趋势图：`summary.csv` → 生成 `benchmark/trend.svg`（Node 脚本即可，无前端依赖）
- 更新 README"评测"章节，把双层设计讲清楚

---

## 三、简历措辞（能吹版，全部有据可查）

### 不要写（露馅）
> 构建 mock-LLM 基准门禁，保障 Agent 回归。

### 要写（双层 + 指标 + 金标 + 可追问）
> 构建**双层 AI 评测体系**：① 真实模型端到端评测——14→N 题四类题型，客观代码验证为权威 + LLM-as-Judge 四维评分 + TRACe 材料利用判官 + CRAG 事实核查，并建立人工金标校验判官一致性（精确匹配 <70% 报警）；② mock-LLM 确定性回归门禁——pass^k 一致性、独立临时库、goalState 状态断言、失败分类 taxonomy，CI 零成本每次跑。指标含 pass@1/EM/成本/延迟/一致性；引入 RAG 后讲解均分 61→81、真实性 correct 40%→82%（消融对比口径，数值为实测）。

### 面试可能的追问 + 标准答案（提前备好）
| 追问 | 标准答案 |
|---|---|
| 评测集多大？ | 当前 N 题 + classify M + web 任务 K；每题带 source 可追溯（面经/题库）；直言"早期 14 题，意识到样本不足后扩到 N"——坦诚 + 迭代演进的回答反而加分 |
| CI 里跑的是真实模型还是 mock？ | 双层：CI 跑确定性 Layer B（机制正确性 + pass^k），真实质量 Layer A 用 --quick 小样本进 CI + 每周 full 定时回归；一键 `npm run bench` 跑全量并出 diff |
| 判官评分会不会失准？ | 三层防线：客观代码验证优先（不依赖判官）、LLM-as-Judge 双评平均 + 金标集校验判官一致性、与人工标注对齐率低于阈值报警——这正是当时设计 judge-check 的原因 |
| 通过率多少、跟什么比？ | pass@1 是"首次通过"，pass^k 是 N 次独立一致通过（机制稳定性）；质量对比是消融 A/B（无 RAG vs 全链路）——不跟别的产品比绝对数，比的是自己体系内的 Δ，这本身就是严谨口径 |
| web-task 之前只有 1 个任务？ | 直说：是的，那是早期 WebArena 试点，现已扩到 K 类 M 任务，按最终产物判定——展示你清楚自己体系的边界 |

---

## 四、落地顺序

```
第 1 周  评测集扩容（questions 60+ / classify 40+ / detect 30+ / gold 30+ / web-tasks 20+）
第 2 周  指标口径（pass①EM/成本/延迟）+ summary.csv 回归 diff + CI quick/judge-check 常驻
第 3 周  消融基线 A/B（无 RAG vs 全链路）→ 拿到可写进简历的 Δ 数字
第 4 周  README/徽章/趋势图 + 双轨可复现性（记录 model/version/dataset hash）
```

**铁律：简历数字 100% 来自实测**。消融 Δ（61→81 之类的）先跑出来拿到真实值再写；拿不到就不写具体数字，写机制描述（机制描述本身已足够强）。
