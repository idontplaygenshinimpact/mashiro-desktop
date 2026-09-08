# Bun 迁移 vs TS 继续升级：评估与方案

> 结论先行：**TS 继续渐进升级（做），Bun 运行时迁移（不做）**。
> Bun 不迁移不是"保守"，是四条硬性约束 + ROI 算账后的结论；TS 升级按依赖热度继续增量推进，全量迁移留到面试后且不保证做。

---

## 一、先对齐一个前提：opencode 选 Bun 的场景 ≠ 我们的场景

opencode 是**每次敲命令都被 spawn 的 CLI**，Bun 的四大优势全部打在其核心痛点上。我们是**长驻服务**（Electron 桌宠主进程 + 8899 widget 服务 + MCP 会话级进程），逐条对照：

| opencode 选 Bun 的理由 | 我们项目是否成立 | 证据 |
|---|---|---|
| ① 启动延迟敏感（10ms vs 200ms） | **不成立**。桌面应用启动一次用一天；widget 服务常驻；MCP server 每个客户端会话只 spawn 一次（秒级等待无感），绝非每次按键 100ms 的 CLI 场景 | `package.json` main 指向 `desktop/main.mjs`；`bin/mashiro-mcp.mjs` 是会话级入口 |
| ② 流式 I/O（SSE ReadableStream 背压） | **收益≈0**。Node 22 ReadableStream 本身无此短板；我们已用自有超时/防重入中间件解决流式卡顿（见 `docs/流式链路超时统一修复工单.md`），问题不在运行时而在链路治理 | 流式链路工单已闭环 |
| ③ 子进程管理（Bun.spawn fork+exec vs child_process IPC） | **不成立**。全项目 `spawn` 相关引用仅 5 处，子进程不是热点；且 Electron 主进程里 spawn 必须走 Node 语义 | `Select-String "child_process|spawn"` 命中 5 |
| ④ TS 零构建直接跑 | **已被 Node 22.18 拿走**。项目已用 `--experimental-strip-types` 直接运行 `lib/ai.ts`，esbuild 打渲染层 bundle——"改完即跑、零构建"的收益已到手 | `package.json` engines `>=22.18`、`tsconfig.json` `allowImportingTsExtensions` |

**关键结论：Bun 为 opencode 解决的四个问题，在我们项目里三个本就不存在，一个已经被 Node 22.18 免费兑现。**

---

## 二、Bun 迁移的四条硬性障碍（任何一条都足以否决）

### 障碍 1：Electron 主进程无法运行 Bun（架构级否决）

产品形态是桌宠应用，`desktop/main.mjs` + `preload.js` 跑在 Electron 内嵌的 Node 运行时里。**Electron 主进程 = 内嵌 Node，Bun 是独立运行时，无法替换主进程。** 旗舰入口永远跑 Node。若只把 widget/MCP 切到 Bun，形成"桌面 Node + 服务 Bun"双运行时割裂：
- 同一份 `lib/` 业务代码在两个运行时各跑一遍，行为差异双份排查；
- 面试拷问"为什么一个项目两个运行时"无法自圆其说；
- 部署/打包（electron-builder + asarUnpack plugins/**）全部绑定 Node。

### 障碍 2：数据层 `node:sqlite` 是踩坑后的核心资产

7 个文件用 `node:sqlite`（`db.mjs`/`backup.mjs`/`scheduler.mjs`/`focus.mjs`/`mail.mjs`/`chrome-cookies.mjs`/`edge-session.mjs`），全部是 `DatabaseSync` 同步 API。Bun 虽实现了 `node:sqlite` 兼容层（[Bun node:sqlite DatabaseSync 参考](https://bun.sh/reference/node/sqlite/DatabaseSync/constructor)），但兼容层 = 行为以 Bun 为准，schema 迁移/约束/类型绑定细节有差异风险。迁移 = 用整个数据层去赌一个兼容实现。

### 障碍 3：本地原生模块的 N-API 兼容风险

`koffi`（FFI）、`sherpa-onnx-node`（本地 TTS 推理）、`@xenova/transformers`（onnxruntime-node）、`playwright`——全是按 Node ABI 构建的原生模块。Bun 的 N-API 支持有已知缺口：onnxruntime 系模块在 Bun 下出现 N-API 崩溃、社区只能回退 WASM 运行时（[rehydra-sdk 的修复 commit：default to WASM runtime on Bun to avoid N-API exit crash](https://github.com/mrosnerr/rehydra-sdk/commit/7cf1952e06038200f3e55119e1f0b0c28d9f5bb2)）。语音合成是产品卖点，为省 190ms 启动把卖点压在兼容赌注上，不值。

### 障碍 4：测试设施是 Node 专有的，迁移即重写

114 个测试文件跑在 `node:test` + `--experimental-test-module-mocks`（Node 专有 flag，package.json `test` script）上。`bun:test` 语义不同，迁移 = 测试设施整体重写 + 重新排查时序偶发。而"测试全绿"是项目红线（`docs/架构师提示词-源码通读与升级改造.md` 红线 3）。

### 附：启动收益本身也可疑

Node 22 冷启动带 strip-types 约 100-200ms，Bun 约 10ms。差值只对"每次敲命令"的 CLI 有意义；MCP 场景会话级 spawn 一次，widget/桌面常驻，**用户可感知收益 ≈ 0**，但成本是双运行时 + 原生模块赌注 + 测试重写。

---

## 三、什么条件下 Bun 才值得（面试也能讲清楚的分界线）

> 我们的分界线：**"常驻/会话级服务"留在 Node，"每次调用都要冷启动的 CLI"才有 Bun 的资格。**

1. 若未来按 `docs/phase4-headless部署-方案.md` 把 widget/MCP 拆成独立 headless 服务部署到容器（多实例/快速扩容），Bun 的小体积 + 快启动才有吞吐价值——且那时 `lib/` 已 100% TS，切 Bun 是纯运行时替换；
2. 若加一个交互式 CLI（`mashiro ask ...`，用户反复敲命令）——这才是 opencode 场景，届时单独用 Bun 包 CLI 入口合理；
3. 触发条件未出现前，**不预设迁移，不做"为了 Bun 而 Bun"**。

---

## 四、TS 继续升级方案（做，增量，按热度）

### 现状盘点（2026-09 实测）

- 343 个 `.mjs` / 3 个 `.ts`（`lib/ai.ts` 已迁 + `lib/types.d.ts` + `desktop/kanban-api.d.ts`）；
- 任务 1（JSDoc + checkJs）✅、任务 2 核心模块部分 ✅（`ai.ts` + 共享类型，17 处 import 已切）；
- `typecheck` 全绿（tsc --noEmit 覆盖 lib/plugins/widget/config/scripts）；
- 明确决策沿用：**`memory.mjs` 不迁**（20+ 调用方含 `#lib` 映射，JSDoc 已完整，见 `docs/TS升级工单.md` 实施记录）。

### 下一批迁移清单（依赖叶子优先 × 改动热度排序）

| 优先级 | 模块 | 迁移理由（面试叙事价值） | 做法 |
|---|---|---|---|
| P0 | `lib/tools/*`（impl-search/fetch/interview 等） | 函数调用边界（tool.run(args)），是"类型文档缺失"痛点原发地 | 迁 `.ts`，用 `ToolResult` 类型约束，JSDoc 已有打底 |
| P0 | `lib/loop.mjs`（agent 主循环） | 串联 ai/tools/memory 的编排核心，面试必拷问"循环如何防呆/代际管理" | 迁 `.ts`，顺手把 `AgentMessage`/`LoopContext` 类型收紧 |
| P1 | `lib/review.mjs`（FSRS 间隔复习） | 算法模块类型收益最大，zod 已有 schema 可对齐 | 迁 `.ts`，参数校验与类型合一 |
| P1 | `lib/stream/*`（流式链路） | 流式是产品卖点 + 拷问热点 | 迁 `.ts`，`StreamController` 类型落地 |
| P2 | `widget.mjs` 路由层 | 只加类型不迁文件：handler 签名用 JSDoc 标注（checkJs 已覆盖，先吃到收益） | 不迁文件 |

**明确不做**：`memory.mjs`（已决策）、`db.mjs` 等 7 个 sqlite 文件（联动多改动大，JSDoc 足矣）、desktop/renderer 原生 JS（已有 `tsconfig.desktop.json` 覆盖双面板，bundle 产物不动）。

### 执行规则（沿用红线）

1. **每模块一个 commit**，先迁后删 .mjs，import 路径 `.mjs → .ts`（已有先例，17 处）；
2. 每 commit 验收：`npm run typecheck` 0 error + `npm test` 全绿（114 个测试文件）；
3. 迁移顺序走依赖叶子优先，杜绝一次大 PR；
4. 全量迁移（任务 3）明确标为**可选、面试后**——收益边际递减，不设 deadline；
5. 故意改错字段的"检查生效证明"（验收③）每批做一次，写进 commit message。

---

## 五·补、专项答辩："agent 是核心卖点 → 为了 agent 能力上 Bun"为什么不成立

> 前提认可：agent 是本项目核心卖点且未到理想形态；插件化（plugin-architecture.md 阶段 1-3 已落地：
> `plugins/job-hunter` + `plugins/plugin-template` + `lib/plugin-loader.mjs` 的 manifest+register(api) 协议、
> skills 工具插件 + hooks 扩展点）是正确投资方向。但"因为 agent 要变强所以要换运行时"因果不成立。

1. **agent 能力的杠杆与运行时正交**。能力 = 编排智能（规划状态机/反思/记忆检索/模型路由/工具并行）×
   模型质量 × 工具生态 × 评测闭环。逐项核对：Bun 不改变任何一项；Bun 的强项（启动/流式/TS 零构建）
   是运行特性不是能力，且前两者在长驻服务上无感、后者已被 Node 22.18 type stripping 拿走。
2. **插件生态最怕宿主运行时动荡**。插件协议（manifest + register(api)）承诺"宿主 API 稳定"；
   换运行时 = 生态承重墙移位：第三方插件按 Node 语义写、原生依赖按 Node ABI 编译，宿主换 Bun 后
   插件作者要面对两套运行时行为差异。生态数学偏向"无聊但稳定的运行时"。
3. **插件隔离问题与运行时无关**。当前单插件 try-catch 隔离（plugin-loader.mjs:98-101）；真正的隔离升级
   是 worker/子进程/VM——Node 与 Bun 都有，不是换运行时的理由。
4. **Bun 真正能帮 agent 的三个点都是"新表面"而非"迁移"**：
   - 形态 A：agent 变成每次冷启动的 CLI（zhenbai ask / headless 命令）→ 10ms 启动有意义（opencode 场景）；
   - 形态 B：大规模并行跑 agent（bench 批量评测、几十路子代理扇出）→ 进程级内存/启动吞吐有意义；
   - 形态 C：插件单文件打包分发（Bun build）→ bundler 便利（esbuild 等价）。
   三者均未落地；落地时按"独立表面"引入 Bun，不动宿主。
5. **决策门禁（可量化）**：等形态 A/B 出现时，先跑 Bun 原型 + 三个指标（agent/MCP 冷启动秒级、
   bench 全量墙钟时间、内存峰值），达标再单独引入；不达标维持 Node。现在迁移 = 为不存在的吞吐付费，
   并给正在建设的插件生态增加未知变量。

## 五、一句话总结（面试叙事版）

> "opencode 选 Bun 是因为它是每次敲命令冷启动的 CLI，Bun 的 10ms 启动/流式/TS 零构建全打在它的核心痛点上。我们是 Electron 主进程 + 长驻服务的形态，Electron 主进程只能用内嵌 Node，Bun 的启动收益在长期运行服务上趋近于零，而迁移代价是双运行时割裂 + node:sqlite 兼容层 + koffi/sherpa-onnx 等 N-API 模块的兼容赌注 + 114 个 node:test 测试重写——ROI 为负。TS 的优势我已经用 Node 22.18 原生 type stripping 拿到（改完即跑、零构建），所以我的决策是：运行时留在 Node，类型系统按依赖热度继续增量迁移，Bun 留作未来 headless 容器化/CLI 场景的备选。"

——体现的判断力：**按"运行时形态 × 收益 × 迁移成本"决策，不跟风技术潮流，不为单一指标（启动速度）付双运行时成本。**
