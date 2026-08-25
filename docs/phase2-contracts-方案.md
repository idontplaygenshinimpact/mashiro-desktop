# Phase 2 技术方案：API 契约层与前后端类型化

> 目标：把 widget REST + SSE 流式 + IPC 三端的"字段形状全靠人肉对齐"改为"契约定义 + 运行时校验 + 共享类型 + 契约测试"。**不改变任何用户可见行为，零破坏现有 142 处路由**。
> 约束：✅ 单包内可做，不依赖 Monorepo；✅ 保持 ESM + checkJs（JS+JSDoc），不引入新的 TS 构建链；✅ 新增依赖仅 zod。

---

## 1. 现状痛点（摸底台账 §2 已核实）

1. **入参校验全手写 ad-hoc**：`core.mjs:97 if(!message) 400 "message required"`、`typeof!==boolean`、`Number.isInteger`+区间、JSON.parse try/catch——散落 60+ 处，风格不一、覆盖率靠自觉。
2. **响应形状无约束**：改 output 字段，前端拿 `undefined` 白屏，只有运行时才知道。
3. **SSE 事件无单一 schema**：`chat-stream`(start/tool_*/done/error)、`study-*stream`(start/delta/done/error)、`oj/collect-all-stream`(progress/done/error) 两端硬编码字段（`preload streamPromise` 只认 done/error/delta/start）。
4. **三端零类型**：全项目 0 个 .d.ts；preload 60 方法无签名；renderer 120 处硬编码 8899 直连；tsconfig 不含 desktop/renderer。
5. **"契约即测试"只到路径+方法**（`routes-registry.test.mjs` 全套 55+9 条路径断言），护不住形状。

---

## 2. 总体设计

### 2.1 架构分层（自底向上）

```
lib/contracts/            ← 契约层（zod schema + JSDoc 类型），唯一事实源
   ├── common.mjs         ← 通用原语（ID/时间戳/分页/错误对象）
   ├── sse.mjs            ← SSE 事件 discriminated union + createSSEPush
   ├── chat.mjs、study.mjs、interview.mjs、review.mjs、
   │   jobs.mjs、oj.mjs、mail.mjs、rss.mjs、settings.mjs、misc.mjs
   └── index.mjs          ← 路由契约注册表（path→method→{input,output}）

lib/routes/router.mjs     ← 扩展：route() 支持可选 schema（第 4 参）
lib/routes/contract.mjs   ← withContract() 包装器（新 handler 风格）
widget.mjs                ← 分发处副作用最小化（新增 schema 路由走新路径）
desktop/preload.js        ← JSDoc 签名 + kanban-api.d.ts
desktop/renderer/api-client.mjs ← 收编直连 fetch 的轻 client
tests/contracts*.test.mjs ← 契约测试
```

### 2.2 核心决策：两种 handler 风格并存（渐进迁移的基石）

- **Legacy（现状，142 处）**：`(req, res) → 自己 readBody / 自己 writeHead / 自己 res.end` —— **一行不动**。
- **Contract（新，逐路由迁移）**：`withContract(纯函数, { input, output })`，**纯逻辑 + 声明形状**，由包装器负责 body 读取、input 校验、output 校验、统一序列化。

```js
// Legacy 现状（core.mjs:94-103）
route("/api/chat", "POST", async (req, res) => {
  readBody(req, res, async (body) => {
    if (!message) { res.writeHead(400); res.end(JSON.stringify({ error: "message required" })); return; }
    try { ... } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
  });
});

// Contract（迁移后）
route(path, "POST", withContract(
  async (input) => chatWithAgent(input.message ?? "", input.history ?? [], input.sessionId),
  { input: ChatInput, output: ChatOutput }
));
```

**契约定义（zod + JSDoc 导出类型，renderer 侧 0 运行时开销）：**

```js
// lib/contracts/chat.mjs
import { z } from "zod";

/** @typedef {{ reply: string, voice: string, history: import("./common.mjs").ChatTurn[] }} ChatOutputT */
export const ChatInput = z.object({
  message: z.string().min(1),
  history: z.array(/* ChatTurn */).max(20).optional(),
  sessionId: z.string().optional(),
});
/** @type {import("zod").ZodType<ChatOutputT>} */
export const ChatOutput = z.object({
  reply: z.string(),
  voice: z.string().default(""),
  history: z.array(/* ChatTurn */).max(6).default([]),
});
```

类型消费（渲染层/测试，`import type` 无运行时依赖）：
```js
/** @type {import("../../lib/contracts/chat.mjs").ChatOutputT} */
let out;
```

---

## 3. 核心机制详述

### 3.1 router.mjs 扩展（向后兼容）
- `route(pathname, method, fn, schema?)`：新增可选第 4 参 `{ input, output }`；缺省时行为与现在完全一致。
- `resolve()` 返回值不变（handler）；新增 `hasSchema()` 供分发判断。
- **不统一改造分发层**——schema 校验由 `withContract` 在 handler 内部完成，避免动 widget.mjs 的 CORS/Bearer/404 逻辑与 body 双读问题。

### 3.2 body 读取策略（关键，避免双读）
- 现状所有 `readBody(req,res,cb)`（`lib/widget-core.mjs:132`）消费一次流。
- `withContract` 内用 Promise 化的 `readBodyJson(req)`（内部复用 widget-core 的读取逻辑，返回 `{ok,body}` 或 `{ok:false,status:400}`）。
- **已迁移路由不再调用 readBody**（body 已在包装器读好）→ 无双读；**未迁移路由照旧 readBody** → 无破坏。

### 3.3 统一错误格式（兼容现状 `{error}`）
```json
// 400（input 校验失败）—— 保留后端人话 + 结构化 issues
{ "error": "VALIDATION_ERROR", "issues": [ { "path": ["message"], "message": "String must contain at least 1 character(s)" } ] }
// 500（output 校验失败，这是真 bug）
{ "error": "SCHEMA_MISMATCH", "issues": [...] }   // + console.error 带路由与字段
```
- `input` 默认 `strip`（剔除未知字段，不 reject——避免历史客户端多发字段被 400 打爆）；逐路由需要时可改 `strict(true)`。
- `output` 默认 `strip`，只保证**必填字段存在且类型对**。

### 3.4 SSE 事件契约（优先做，最易漂移的区域）
```js
// lib/contracts/sse.mjs —— 单一 discriminated union
export const SSEEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("delta"), delta: z.string() }),
  z.object({ type: z.literal("progress"), done: z.number(), total: z.number(), title: z.string() }),
  z.object({ type: z.literal("done"), reply: z.string().optional(), saved: z.boolean().optional(), /* ...按端点收敛 */ }),
  z.object({ type: z.literal("error"), error: z.string() }),
]);
// 工具事件（chat-stream 专用）
export const SSEToolEvent = z.union([ /* tool_start/tool_done/tool_error */ ]);
export const ChatStreamEvent = z.union([SSEEvent, SSEToolEvent, z.object({type:z.literal("agent_done"), ...})]);
```
- 新增 `createSSEPush(res, { validate })`（替代 core.mjs:151-157 / study.mjs:76-82 的散装 push）：统一 `data: JSON\n\n` 序列化 + heartbeat + `validate ? event.safeParse 失败即 console.error`（开发期暴露漂移；`MIANSHI_SSE_STRICT` 关闭时跳过校验零开销）。
- **两端（preload streamPromise + renderer 手解析）用同一 union**：preload 的 `streamPromise` 借此在开发期校验事件形状；`panel-rest.js:843` 的 getReader 手解析保留（兼容），但走同一 union 的类型。

### 3.5 preload / 渲染层类型化
- `desktop/kanban-api.d.ts`：`export interface KanbanApi { chat(args: ChatInputT): Promise<ChatOutputT>; studyDetailStream(...): ...; /* 60 方法全量 */ }` + `declare global { interface Window { kanban: import("./kanban-api").KanbanApi } }`。
- `preload.js` 顶部 `/// <reference path="./kanban-api.d.ts" />` + 方法实现处 `/** @type {KanbanApi["chat"]} */` 标注（checkJs 校验实现与声明一致）。
- 新增 `tsconfig.desktop.json`（include `desktop/**`，lib: DOM+ES2022，checkJs）与脚本 `typecheck:desktop`，**不污染现有 lib 的 tsconfig**（main.mjs 是 node 环境、renderer 是 dom 环境，必须分开）。
- `desktop/renderer/api-client.mjs`：`api(path, {method, body}) → fetch(baseURL+path)`，`baseURL = "http://127.0.0.1:8899"` 单一常量（收编 120 处硬编码）；类型 `Promise<T>` 由调用处 JSDoc 指定。

### 3.6 契约测试（把"契约即测试"从路径级升级到形状级）
- `tests/contracts.test.mjs`：对每个有 input 的路由契约做 **正/反样例**（合法通过、缺字段拒绝、类型错拒绝、未知字段 strip）；断言 400 错误结构含 issues。
- `tests/sse-contract.test.mjs`：构造每个事件 → `data: JSON\n\n` 序列化 → 反解后 `safeParse` 通过；**模拟"字段改名"用例证明契约能拦住漂移**。
- 保留并扩展 `routes-registry.test.mjs`（路径断言 + 新增"哪些路由已挂契约"覆盖率断言，如 `contractCoverage >= 20%` 起步）。

---

## 4. 渐进迁移 Wave（每阶段后全量回归）

| Wave | 内容 | 工作量 | 回归验证 |
|---|---|---|---|
| **0 基建** | 引 zod；建 `lib/contracts/` 骨架（common/sse）+ `withContract` + `readBodyJson` + 错误格式 + `tests/contracts.test.mjs` 框架；**不迁移任何路由**（纯新增，零破坏） | 0.5 天 | 现有测试全绿 |
| **1 SSE 契约** | `createSSEPush` 统一 core/study/review/oj 的 push；定义 ChatStreamEvent/StudyStreamEvent union；preload streamPromise 接入校验（开发期） | 0.5~1 天 | npm test + smoke |
| **2 高频路由迁移** | chat / chat-sessions / study-plan / study-check / interview start·answer·end / review due·submit / settings·patch / job collect（约 20 个，选接口最乱、前端调用最多的） | 1~1.5 天 | smoke + e2e |
| **3 类型化 + 收编直连** | kanban-api.d.ts + tsconfig.desktop + typecheck:desktop 进 CI；api-client.mjs 替换 panel-*.js 高频直连（jobs/rest 首批）；CI 加 `typecheck:desktop` + `contracts.test` | 1 天 | build:renderer + check:renderer + 全量 |

**路由迁移顺序原则**：`接口使用频率高 ∧ 字段漂移风险大（流式/多端消费）` 优先；新增路由**必须**带契约（Code Review 门槛）。

---

## 5. 验收标准（可测）

1. `npm test` 全绿（90+ 文件，含新增 contracts 测试）且**无任何既有用例改动因本次变更失效**。
2. `curl -X POST 127.0.0.1:8899/api/chat -H "Authorization: Bearer $TOKEN" -d '{}'` → 结构化 400（`VALIDATION_ERROR` + issues），而非现在的实现内捕获。
3. 人为把 `ChatOutput.reply` 改名 → `contracts.test.mjs` 红 +（若迁移 chat）typecheck 红，**证明契约真的拦得住漂移**。
4. SSE：构造一个 `{type:"deno","delta":...}` 拼错事件 → 开发期 `SSE_STRICT` 打开时 console 报错/测试红。
5. `build:renderer` + `check:renderer` 通过；renderer bundle 体积增量 = zod（仅当实际 import 运行时 schema 才打包；纯 `import type` 0 增量）。
6. `bench:agent` / `bench:bench` 不受影响（契约层不碰 agent 核心）。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| body 双读破坏旧 handler | 只有挂契约的路由改走 readBodyJson，旧路由不碰；any 处 ReadBodyJson 复用 widget-core 同款读取，limit 一致（MAX_BODY） |
| output 校验误杀合法响应 | 默认 strip，只要求必填字段类型对；`strict` 逐路由显式开启 |
| zod 进 renderer bundle 体积 | 渲染层用 JSDoc `import type` 0 运行时开销；需要运行时校验的接口才 import zod（可控） |
| 双 tsconfig 维护成本 | desktop 与 lib 环境本就不同（DOM vs Node），分开是对的；`typecheck:desktop` 只查 `desktop/**` |
| 迁移战线过长 | Wave 门槛：先 20 个高频 + 新路由强制契约，存量不限期追平；contractCoverage 断言随迁移提高 |
| 与 Phase 3（PKCE）/ Phase 4（部署）冲突 | 契约层只依赖 widget 现结构，与鉴权/部署正交；`readBodyJson`、错误格式可被未来统一网关复用 |

---

## 7. 依赖与产出物

- 新增依赖：`zod`（唯一）。
- 新增文件：`lib/contracts/*`（约 12 个）、`lib/routes/contract.mjs`、`desktop/kanban-api.d.ts`、`tsconfig.desktop.json`、`desktop/renderer/api-client.mjs`、`tests/contracts.test.mjs`、`tests/sse-contract.test.mjs`。
- 修改文件：`lib/routes/router.mjs`（route 第 4 参）、`preload.js`（JSDoc）、CI 添加 `typecheck:desktop` + 契约测试 job/step、CI 的 check-renderer 前加 build:renderer（已有）。

---

## 8. 完成后"能讲什么"（对应简历承诺）

- **契约驱动开发**：路由注册即声明 `{input, output}`，142 处汇聚点一处接入；新接口不写契约过不了 review。
- **前后端类型映射**：`lib/contracts` 是 lib/routes 与 preload/renderer 的唯一事实源；`import type` 在 renderer 0 运行时成本。
- **双向校验闭环**：入参 400 结构化、出参 SCHEMA_MISMATCH 即 bug、SSE 事件 union 防漂移、契约测试正反样例。
- **未来迁移 Monorepo 时**：`lib/contracts` 直接抽成 `packages/contracts`（纯 zod + JSDoc，无内部依赖），是拆包最安全的一块。
