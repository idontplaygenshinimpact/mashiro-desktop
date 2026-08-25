# Phase 事件驱动内核 + Claude Code 桌宠伴侣 技术方案

> 目标：把桌宠从"请求-响应"（等你发消息）升级为**事件驱动自主**（收到外部事件能自己决定做什么并表达出来）；第一步落地**形态 B：Claude Code 伴侣**——桌宠能看到 CC 在干什么，用气泡/语音/面板陪伴与播报。
> 前置：事件模型（hooks.mjs 已有雏形）、表达通道（petSay 已有）、agent 内核（lib/agent.mjs）、审批（deny-first）全部存在，**缺的是"串起来的自主层"**。

---

## 1. 现状盘点（已核实，带证据）

| 零件 | 现状 | 证据 |
|---|---|---|
| 内部事件系统 | ✅ `hooks.mjs`：onHook/emitHook，**对标 Claude Code hooks**（PreToolUse/PostToolUse/Notification 思路）；agent 已发 `chat_done` 等 | lib/hooks.mjs:1,16,29 |
| 表达通道（气泡+语音） | ✅ `petSay(text, scene)` 主进程广播 `pet-say` 事件，桌宠 app.js 订阅显示气泡+播语音；已有 `focus-start` 场景在用 | desktop/main.mjs:1145-1149,1183 |
| 定时/后台体系 | ✅ registerTimer/Interval、巡检验证、日程提醒（30min）、邮箱自动检查、持久化 scheduler（OpenClaw Automations 风格，ADDITIVE 层） | widget.mjs:477-478,532-533,588,605-610 |
| agent 内核 | ✅ chatWithAgent（工具循环/审批/记忆/多轮），但**仅请求-响应** | lib/agent.mjs |
| 决策规则引擎 | ✅ loop.mjs `loopSuggest`（"当前最该做什么"），原则"决策用规则、LLM 只提炼" | lib/loop.mjs |
| 通信形态 | ✅ widget 是独立进程，主进程**拉模型**（widgetFetch/轮询），无反向通道 | desktop/main.mjs widgetFetch |
| 外部 Agent | Claude Code 会话存为 jsonl 文件（`~/.claude/projects/**/*.jsonl`，增量可解析）——**零侵入的感知源** | 外部事实 |

## 2. 整体架构

```
感知层      CC 会话文件 watcher（新增） + 时间/日程/内部 hooks（已有）
                │ 统一事件模型 { type, source, ts, payload }
事件总线    lib/events.mjs（新增；hooks.mjs 之上扩展，含待播报队列）
                │
决策层      lib/autonomy.mjs（新增）：规则决策（LLM 仅精炼文案）
                │  三级模式 off/notify/full × 防抖 × 寂静期 × 预算 × 审批
行动/表达   pet-events 队列（widget /api/pet-events drain）
                │  主进程 2s 轻轮询（复用拉模型，不加反向通道）
           petSay(text, scene)（已有）→ 桌宠气泡 + 语音
```

## 3. 统一事件模型（lib/events.mjs）

在 hooks.mjs 之上扩展（不重写）：
```js
// Event envelope —— 所有事件源共同的形状
{ type: "cc:session_started" | "chat_done" | "schedule_due" | "...",
  source: "cc-watcher" | "agent" | "scheduler" | "...",
  ts: 1700000000000, payload: { /* 事件专属字段 */ } }

// 两类消费者：
//  1. 决策层订阅（emitEvent → autonomy 判断要不要动）
//  2. 表达队列（需播报的入队，供主进程 drain：{text, scene, ttl}）
```
- **不改造现有 emitHook 调用点**：事件总线是 ADDITIVE 层（与 scheduler 同风格），`emitEvent` 内部转发 `emitHook` 保持 hooks 生态兼容

## 4. 事件源适配器（新增）

### 4.1 CC 会话文件 watcher（首选，零侵入）—— `lib/adapters/cc-watcher.mjs`
- 监听 `~/.claude/projects/**/*.jsonl`（`fs.watch` 目录 + mtime 增量解析，**幂等**：记录每个文件已解析行尾偏移）
- 解析出的事件（从 jsonl 消息推断）：
  - 会话创建 → `cc:session_started`（payload: 会话名/目录/时间）
  - assistant 消息（回复产出）→ `cc:assistant_reply`（长度/是否含 tool_use）
  - tool_use/tool_result → `cc:tool_use`（工具名）
  - 会话结束（新 sessionId 停止写入/超时判定）→ `cc:session_finished`
- **隐私与成本纪律**：只解析**事件元数据**（类型/时长/工具名/回复长度），**不落 CC 正文内容**到项目库——桌宠只需要"在干什么"，不需要"内容是什么"
- 环境开关：`MIANSHI_CC_WATCH=0` 关闭；watcher 属于后台任务，受 `MIANSHI_DISABLE_BACKGROUND=1` 一并约束

### 4.2 CC hooks 适配器（可选，push 型）
- 用户 `.claude/settings.json` 配置 hooks 事件（如 `Stop`/`PreToolUse`）→ 调 `mashiro-cli event <json>`（新增 bin 脚本）→ POST widget `/api/external-event`
- **为什么放可选**：hooks 事件精准但需要用户配置；jsonl watcher 零配置先让"开箱即用"成立，hooks 作为精度增强

### 4.3 时间/日程/内部（已有，直接挂总线）
- `checkScheduleReminder`（widget.mjs:338）→ `schedule_due`
- agent 的 `chat_done`（已有 emitHook）→ 归一到事件总线
- 巡检/邮箱事件保留原逻辑，仅播报级事件入表达队列

## 5. 决策层（lib/autonomy.mjs）—— 规则决策，LLM 仅精炼

**遵循 loop.mjs 的原则："决策用规则、LLM 只提炼"**（快、省、可测、可讲）：
- **规则表**（每条事件类型 → 候选动作，纯函数可测）：
  | 事件 | 默认动作（notify 级） |
  |---|---|
  | cc:session_started | 气泡"🎬 Claude Code 开跑了"+ scene `agent-start` |
  | cc:tool_use | 静默（防打扰）|
  | cc:assistant_reply（回复产出）| 气泡短句 + 可选语音（语音仅 full 级）|
  | cc:session_finished | 气泡"✅ 完成了"+ 时长效用提示 |
  | chat_done（本地对话）| 保持现状（不走表达队列）|
  | schedule_due | 气泡 + 语音提示（沿用现有提醒逻辑）|
- **可选 LLM 精炼**（仅 full 级）：对小调用（maxTokens 120、temperature 0.7）把 `{type, meta}` 精炼成一句人话；失败降级用规则模板（**不允许 LLM 失败阻塞播报**）
- **动作输出契约**（进表达队列）：`{ text, scene, ttl: 默认 60s, level: "bubble"|"bubble+voice" }`——场景走现有 voice-pack/playScene 映射（`desktop` 侧已有）

## 6. 安全与成本控制（自主性的刹车，必须和引擎一起交付）

- **三级模式**（env + 设置中心可配）：`MIANSHI_AUTONOMY=off | notify | full`，默认 **notify**（只播报外部事件，不自主发起动作）；full 才允许"自主决定做点事"（调工具），且**走现有 deny-first 审批**（low-risk 只读/播报自主，high-risk 必须审批——permission.mjs 已有）
- **防抖**：同 source 同 type 5s 合并（jsonl 连续写入不刷屏）
- **寂静期**：上次表达后 60s 内除非紧急（schedule_due 除外）不主动打扰
- **预算**：每日自发表达上限（默认 20 条，env `MIANSHI_AUTONOMY_BUDGET`）；LLM 精炼每日次数上限（默认 10 次）；超限自动降级静默并写日志——**成本可预测，不会烧钱**
- **单轮上限**：一次事件最多触发一轮决策，不产生自我递归循环
- **审计**：所有自主表达入 `decision_ledger`/trace（复用 lib/trace.mjs），谁在什么时候说了什么都可查

## 7. 表达链路（复用现有，不加反向通道）

1. `lib/events.mjs` 表达队列（内存，TTL 过期丢弃）
2. widget 新增 `GET /api/pet-events`（Bearer 已有；drain 语义：取走即清空）——主进程 2s 轮询（**仅当队列非空才返回数据**，空闲零开销；与现有 30s ensure 心跳并存）
3. 主进程 `main.mjs`：新 `ipcMain.handle("widget:pet-events")`（或并入现有 widgetFetch 组）+ 2s interval 轮询 → 命中调 `petSay(text, scene)`（已有）
4. 桌宠 app.js 订阅 `pet-say`（已有）→ 气泡 + 语音；面板未订阅则忽略（现有行为）
- **不新增数据通道**：完全复用"widget HTTP + 主进程拉 + petSay 广播"现有链路

## 8. 端到端场景（Claude Code 伴侣）

```
用户：claude "帮我总结这几篇面经"（用户侧零改动，桌宠已安装）
桌宠：jsonl watcher 发现新会话 → cc:session_started
     → autonomy(notify) 规则 → 气泡"🎬 Claude Code 开跑了"（无语音）
     → 工具调用时静默；回复产出时气泡"📝 出结果了，去看看"
     → 会话结束 → 气泡"✅ 完成，用时 4 分钟"+ 可选场景语音
另外：任何时刻 CC 关闭 watch 目录（~/.claude/projects 不存在）→ watcher 优雅降级为"未检测到 CC"
```

## 9. 文件清单与改动

**新增**
- `lib/events.mjs`（事件总线 + 表达队列；叠加在 hooks 上）
- `lib/autonomy.mjs`（规则表 + 三级模式 + 防抖/寂静/预算/单轮上限）
- `lib/adapters/cc-watcher.mjs`（jsonl 增量 watcher，幂等偏移解析）
- `bin/mashiro-cli.mjs`（可选：hooks push 型适配器的接收端 `mashiro-cli event <json>`）
- `tests/events.test.mjs`、`tests/autonomy.test.mjs`、`tests/cc-watcher.test.mjs`（临时目录 mock jsonl）
- `docs/cc-companion.md`（用户侧说明：装了什么、默认行为、autonomy 模式怎么开、隐私说明）

**修改**
- `widget.mjs`：注册 watcher + 事件总线接线 + `/api/pet-events` 端点（受 `MIANSHI_DISABLE_BACKGROUND`/`MIANSHI_AUTONOMY` 控制）
- `desktop/main.mjs`：2s 轻轮询 pet-events → petSay（约 20 行）
- `preload.js`：暴露 `getPetEvents`（若有需要；pet-say 订阅通道已存在则不动）
- `package.json`：env 文档化 + 无新依赖

## 10. 测试与验收

1. `tests/autonomy.test.mjs`：规则表纯函数全断言（防抖/寂静/预算/模式开关）；预算耗尽后事件不产生表达且有日志
2. `tests/cc-watcher.test.mjs`：mock jsonl（写→追加→多文件），断言事件类型正确、**重复扫描幂等**（重启/多次 poll 不重复出事件）
3. 端到端（人工）：真实 `claude` 跑一句 → 桌宠气泡出现（气泡/语音效果走现有 petSay）
4. 回归：现有 `npm test` 全绿；`bench:agent` 不受影响（无新 LLM 调用路径——**LLM 精炼仅 full 级且默认 notify 不触发**，CI 零成本）
5. 安全验证：`MIANSHI_AUTONOMY=off` 时 watcher 不启动；full 级自主动作仍走审批（mock 审批用例）

## 11. 工作量与 Wave

| Wave | 内容 | 工作量 |
|---|---|---|
| W1 | `lib/events.mjs`（总线+队列）+ widget `/api/pet-events` + main 2s 轮询 + preload | 0.5~1 天 |
| W2 | `cc-watcher.mjs` + mock 测试（幂等/增量） | 1 天 |
| W3 | `autonomy.mjs`（规则/模式/防抖/预算）+ 测试 | 1~1.5 天 |
| W4 | 端到端联调（真实 claude 跑一遍）+ docs/cc-companion.md | 0.5 天 |

## 12. 后续扩展（同架构，新适配器即可）

- **OpenCode**：会话文件/插件事件 → 新适配器（`lib/adapters/opencode.mjs`）
- **Codex**：`codex --json` 管道 或 hooks → 新适配器
- **skill 装配（P1）**：事件 → 场景 → 激活 skill（事件源挂到总线，决策层加一条规则即可）
- **表达渲染管线（P2）**：petSay 的 `scene` 参数已预留，接 emotion/motion 映射，改表达层不动总线

---

## 13. 诚实边界（写简历前）

- 这是"**感知 + 自主播报**"，不是"通用自主 agent 平台"——全称是"事件驱动的自主表达（notify 级）+ 可升级 full 级自主动作（仍走审批）"，画多大饼就得多大的刹车
- "自学习"不在本方案：本方案是 P0（感知-决策-表达），反思闭环是 P3（后续），简历别把 P3 的承诺挂到 P0 头上
- CC 伴侣的价值叙述是"桌宠成为工作流的陪伴者"，可 demo（真实 claude 跑一遍气泡就出来），可追问（事件模型/幂等解析/预算刹车都可讲 file:line）