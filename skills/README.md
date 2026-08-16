# Skills 插件开发指南

mianshi-agent 的插件机制（参考 DeepSeek Harness / OpenClaw / Claude Code 插件体系）：
**目录即插即用，不改 agent 内核**。一个技能 = `skills/<name>/` 目录，支持两种形态（可叠加）：

```
skills/
└── my-skill/
    ├── SKILL.md      # 声明式（可选）：frontmatter 元信息 + 正文使用说明（注入 agent system prompt）
    └── skill.mjs     # 可编程（可选）：动态工具 / system 说明 / hooks 事件监听
```

## 形态一：纯声明（SKILL.md 就够了）

```markdown
---
name: my-skill
description: 一句话说明这个技能什么时候用（agent 据此决定是否调用）
---

# 技能正文

详细使用说明，agent 会把它作为 system prompt 的一部分读到。
比如：当用户问 XX 时，调用 skill__my-skill__xxx 工具，参数格式是……
```

- `name`：技能唯一 id（`[\w-]+`，与目录名一致）
- `description`：**写"何时用"**，agent 靠它做工具选择
- 正文：写"怎么用/注意事项"，agent 每次对话都看得到

## 形态二：可编程（skill.mjs）

```js
export const name = "my-skill";          // 技能 id（与目录名一致）
export const description = "何时用这个技能";  // 可选（SKILL.md 已有则省略）
export const system = "追加的 system 说明";    // 可选（与 SKILL.md 正文合并注入）

// 可选：动态工具（agent 可调用的函数）
export const tools = [
  {
    name: "do_thing",
    description: "工具做什么（含参数说明），agent 靠描述决定参数",
    parameters: {                       // OpenAI function calling schema
      type: "object",
      properties: { input: { type: "string", description: "输入" } },
      required: ["input"],
    },
    permission: "auto",                 // auto=只读免审批（默认）| confirm=走用户审批
    async run(args) { return { ok: true, result: "..." }; },  // 返回 {ok|error, ...}
  },
];

// 可选：hooks 事件监听（自动接线到 lib/hooks.mjs）
export const hooks = {
  after_tool: (p) => { /* 每次工具执行后回调 {toolName, args, ok, error, durationMs} */ },
  chat_done: (p) => { /* 对话完成后 {userMsg, reply} */ },
};
```

## 生命周期与运行时管理

| 操作 | 方式 |
|---|---|
| 安装 | 新建 `skills/<name>/` 目录 + 文件，**无需改任何代码** |
| 热重载 | `POST /api/skills/reload`（开发插件不用重启桌宠；旧 hooks 自动清理） |
| 运行时查询 | `GET /api/skills` 或 agent 对话里调 `skill_inspect`（先查接口再写代码，勿凭记忆猜工具名） |
| 失败隔离 | 单个技能加载/运行抛错只记日志，不影响其他技能与 agent 主流程 |
| 权限 | 工具 `permission: "confirm"` → 走面板审批条（用户确认后才执行） |

## 工具命名空间与调用

- 工具全名：`skill__<技能名>__<工具名>`（agent 侧唯一标识）
- 技能内可用事件：`before_tool`（返回 `{deny, reason}` 可拦截）、`after_tool`、`llm_done`、`chat_done`
- hooks 监听器抛错被 hooks 层隔离，不会拖垮 agent

## 内置示例

- `skills/github-repo/`：查询 GitHub 仓库信息（SKILL.md + skill.mjs 双形态示例）
- 测试夹具：`tests/fixtures/skills/`（good-skill 双形态 + hooks、md-only-skill 纯声明、bad-skill 隔离验证）

## 建议

1. 能声明就不编程：SKILL.md 能表达的（使用说明/流程），不要写代码
2. `description` 写"何时用"而不是"是什么"——agent 的工具选择靠它
3. 工具参数 schema 写清楚，agent 才能正确传参（validateArgs 会校验必填与类型）
4. 新技能加一个 `tests/skills.test.mjs` 风格的用例，保证隔离与路由
