# CC 桌宠伴侣（事件驱动内核）用户说明

> 桌宠从"请求-响应"升级为**事件驱动自主**：能看到 Claude Code 在干什么，用气泡陪伴与播报。
> 实现：`~/.claude/projects/**/*.jsonl` 会话文件零侵入监听（不装插件、不改 CC 配置）→
> 事件总线 → 规则决策 → 表达队列 → 主进程轮询 → 桌宠气泡。

## 装了什么

| 组件 | 位置 | 说明 |
|---|---|---|
| 事件总线 + 表达队列 | `lib/events.mjs` | 统一事件模型 + `/api/pet-events` drain |
| CC 会话 watcher | `lib/adapters/cc-watcher.mjs` | jsonl 增量幂等解析（2s 扫描） |
| 自主决策层 | `lib/autonomy.mjs` | 规则决策 + 三级模式 + 防抖/寂静/预算刹车 |
| 主进程轮询器 | `desktop/lib/companion-poller.mjs` | 2s 拉表达 → petSay 气泡+语音 |

## 默认行为（开箱即用）

| 事件 | 桌宠表现 |
|---|---|
| CC 开始新会话 | 气泡 "🎬 Claude Code 开跑了" |
| CC 调用工具 | 静默（防打扰） |
| CC 产出回复 | 气泡 "📝 CC 出结果了，去看看" |
| CC 会话结束 | 气泡 "✅ CC 完成（X 分钟，用了 N 个工具）" |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIANSHI_AUTONOMY` | `notify` | `off`=完全不播报不启动 watcher；`notify`=只播报外部事件；`full`=额外允许 LLM 把事件精炼成一句人话（日上限 10 次） |
| `MIANSHI_AUTONOMY_BUDGET` | `20` | 每日自发表达条数上限（超限静默并写日志） |
| `MIANSHI_CC_WATCH` | 开启 | `0`=关闭 CC 会话监听 |
| `MIANSHI_DISABLE_BACKGROUND` | 关闭 | `1`=一并关闭 watcher（测试/无后台场景） |

## 隐私说明

- **只解析事件元数据**（会话开始/结束/工具名/回复长度），**不读取、不落盘 CC 对话正文内容**
- 所有自主表达写入 `decision_ledger`（审计：谁在什么时候说了什么），metadata-only，不含工具参数/内容
- 表达走本地 127.0.0.1 链路，无外部网络请求

## 手动验证

```bash
# 1) 模拟 CC 会话文件跑通全链（不需要真实 claude）
node scripts/smoke-companion.mjs
# 2) 真实场景：正常使用 claude，桌宠会随会话活动出气泡
```

## main.mjs 接线（待语音升级合入后补）

`desktop/lib/companion-poller.mjs` 已就绪，main.mjs 需要 1-2 行启动接线：

```js
import { startCompanionPoller } from "./lib/companion-poller.mjs";
// app ready 后：
startCompanionPoller({ widgetFetch, petSay });
```

（为避免与并行进行的语音升级流水线改动冲突，该接线在语音合入后补——poller 模块本身已独立可测。）

## 边界（诚实说明）

- 这是"**感知 + 自主播报**"，不是"通用自主 agent 平台"——full 级自主动作仍走现有 deny-first 审批，不会未经批准调工具
- "自学习/反思闭环"不在本阶段（后续 P3）
- 未安装/未使用 Claude Code 时 watcher 优雅降级（检测不到会话目录即静默，零开销）
