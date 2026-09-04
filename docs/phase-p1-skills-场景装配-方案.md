# Phase P1：Skill 场景装配 技术方案

> 目标：把 skills/（现有 10 个技能）从"启动全量加载、全部注入 agent prompt"升级为**"事件驱动场景 → 按需激活技能子集"**，配合 P0 事件总线完成"桌宠知道现在该用哪套能力"。
> 收益：① agent system prompt 只注入当前场景相关技能（省 token、命中率高、少幻觉）；② 技能随场景自动切换（面试中/CC 伴侣/复习…）；③ 与 P0 的 autonomy 动作链打通。

---

## 1. 现状（已核实）

| 项 | 现状 | 证据 |
|---|---|---|
| 加载机制 | `loadSkills()` **全量扫描 skills/ 目录**，每个 skill 的 tools/hooks/hints 全部注册；hints（name/description/system）全部注入 agent system prompt | lib/skills.mjs:47-119 |
| reload | 支持 `{force:true}` 重扫 + `?v=` 模块版本号（热更已具备） | lib/skills.mjs:40-41 |
| enabled | 头部注释声明"enabled 配置可禁用"，但**无按场景子集加载**能力（加载即全量） | lib/skills.mjs:3 |
| 技能清单 | company-intel / frontend-cheatsheet / github-repo / interview-warmup / resume-coach / tech-compare（SKILL.md 声明 + skill.mjs 可选编程） | skills/ 目录 |
| 命名空间 | 工具 `skill__<名>__<工具>`；hooks 自动注册 hooks.mjs | lib/skills.mjs:92,104-108 |
| 事件总线 | P0 方案：`lib/events.mjs`（事件模型 + 表达队列），autonomy 决策层 | docs/phase-autonomy-…-方案.md |

## 二、设计：场景（Scenario）= 事件 → 技能子集的映射

```
事件总线（P0） → lib/scenarios.mjs 场景解析器
                    ↓ 匹配最高优先级场景
              场景激活集合 { skills: ["resume-coach", ...] }
                    ↓
              skills.mjs 按集合加载（only 过滤）
                    ↓
              agent prompt 只注入该场景 hints
```

### 2.1 场景定义（声明式，可测试）
```js
// lib/scenarios.mjs —— 场景即配置
export const SCENARIOS = [
  {
    id: "interview", name: "面试陪练",
    when: (ev) => ev.type === "interview:started" || ev.type === "widget:timer",
    skills: ["interview-warmup", "resume-coach"],
  },
  {
    id: "companion", name: "CC 陪伴",
    when: (ev) => ev.type.startsWith("cc:"),
    skills: ["company-intel", "tech-compare"],   // 陪伴期间可查询/对比
  },
  {
    id: "study", name: "学习模式",
    when: (ev) => ev.type === "study:opened",
    skills: ["frontend-cheatsheet"],
  },
  { id: "default", name: "默认", when: () => true, skills: [] }, // 兜底：不注入任何技能
];
```
- **when = 纯函数**（可测、无副作用），事件负载入参
- **场景优先级 = 数组顺序**（首个命中生效）；`default` 兜底保证永远有场景

### 2.2 场景状态（当前激活场景）
- `currentScenario` 存在 `data/scene-state.json`（原子写，复用 atomic-json）——重启恢复，不回落到全量
- 场景切换事件：`scene:switched`（监听者：skills 重载 + autonomy 表达）

### 2.3 skills.mjs 最小改造（向后兼容）
- `loadSkills(dir, { only: ["resume-coach", ...] })`：仅加载名单内技能；缺省（不传 only）= 现行为全量加载（**老调用方零感知**）
- `activeHints()` / `activeTools()`：只返回当前场景集（agent 侧接这个，而不是全量）
- 缓存键 = `dir + only 的 join`（不同场景各自缓存，切换零重扫开销）

### 2.4 agent 接线（最小侵入）
- `lib/agent.mjs` 现有的 skill 提示注入处：把"全量 hints"换成 `activeHints()`（当前场景）
- 说明：现有 agent 工具注册（loadSkills 的 tools）也走 only 集合——场景外技能的工具不可调（LLM 看不到 = 不会误调）

---

## 三、与 P0 的接线（场景切换即"动作"）

事件总线场景解析在 autonomy 决策前运行（P0 方案 §5 规则表前加一层）：
```
事件 → scenes 匹配（新场景?）→ 若切换：重载 skills(only) + emit scene:switched
     → autonomy 规则（决定是否播报）→ 表达队列
```
- 场景切换本身**不是播报动作**（不打扰），只是能力装配变化
- `scene:switched` 也可触发一次 notify 级表达（可选：`气泡"已切换到面试模式"`，频率受防抖/预算约束）

---

## 四、测试与验收

1. **纯函数测试**（tests/scenarios.test.mjs）：
   - 事件→场景匹配正确（含优先级、default 兜底）
   - 切换：A→B→A 幂等（不重复重载）
   - 无效事件（未匹配任何场景）→ default，不崩溃
2. **加载隔离测试**：
   - `loadSkills(dir, {only:["resume-coach"]})` 只注入该技能 tools/hints（断言数量）
   - 目录损坏 skill 仍隔离（既有行为不回归）
3. **端到端**：
   - 跑 `startInterview` → 场景切到 interview → agent prompt 含 interview-warmup hints、不含 company-intro
   - 现有全量加载路径（不传 only）行为不变（回归断言）
4. **回归**：现有 `npm test` 全绿（skills.test.mjs 补 only 用例）

---

## 五、文件清单

| 动作 | 文件 |
|---|---|
| 新增 | `lib/scenarios.mjs`（场景声明 + 解析 + 状态管理）、`tests/scenarios.test.mjs` |
| 修改 | `lib/skills.mjs`（only 参数 + activeHints/activeTools，向后兼容）、`lib/agent.mjs`（注入点改 active）、`widget.mjs`（总线接场景解析，约 10 行）、`data/scene.json`（状态文件） |
| 不改 | skills/ 六个技能本体（零改动）|

---

## 六、边界与诚实说明

- **不新增任何 LLM 调用**：场景匹配全规则，成本 = 0（延续 loop.mjs"决策用规则"原则）
- **不改变技能能力**：只是"加载时机与可见性"变化，skill 内代码零改动
- 场景是**策略**不是**功能**：面试场景配哪些技能，随时改 SCENARIOS 数组即可，可测可讲
- 与 P2（表达管线）关系：P2 是"怎么演"，P1 是"会什么"，正交，可在 P0 后并行

---

## 七、完成后能讲什么（简历/面试）

- "按场景装配技能：面试/陪伴/学习三场景自动切换，agent prompt 技能注入从全量 6 个降到场景子集，省 token、降幻觉面"——可讲 file:line（lib/scenarios.mjs 场景表 + skills only 机制）
- 与 P0 一起构成"事件驱动自主桌宠"的能力闭环：感知→决策→装配→表达，每层都有测试

