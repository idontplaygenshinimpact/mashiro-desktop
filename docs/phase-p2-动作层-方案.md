# P2 动作层：真白模型动作资产与情绪表达映射 技术方案

> 范围：只做 P2 四件套里的"**动作（motion）**"这一件（用户指定）；表情（expression）已有资产验证、语音流水线为独立方案。
> 结论：真白模型（mashiro-zamp ryoufuku，项目默认加载）自带 **15 个动作文件**（12 交互 + 3 说话口型），pixi-live2d-display 播放 API 已验证可用（项目正在用 `model.motion("idle")`），本方案把"情绪 → 动作"映射与播放控制落成实现。

---

## 1. 动作资产盘点（已逐文件核实）

**交互动作 12 个**（`ryoufuku.motions/motion1~12.mtn`，model.json 中 `flick_head` 与 `tap_body` 两组**引用同一批文件**，仅 idle 用 motion3/9）：

| 文件 | 关键参数（实测） | 语义推断（待目测校准） |
|---|---|---|
| motion1 | 低头 30° | 大幅点头/鞠躬（认真、同意、致意） |
| motion4 / 5 / 7 | 低头 21°/30°/30° | 点头系（强度递减：4<5=7） |
| motion10 | 低头 30° + 身体 4° | 点头 + 转身 |
| motion12 | 低头 30° + 侧头 9° + 身体 10° | 综合大幅度（惊喜/响应） |
| motion2 / 8 | 侧头 26°（左右） | 歪头（疑惑、倾听、卖萌） |
| motion3 / 9 | 低头 11° + 侧头 11° | 小幅度晃头 = **idle 待机** |
| motion6 | 无明显参数 | 微动（疑似极小动作） |
| motion11 | 身体 4°，无头动 | 身体微转（回避/叹气） |

**说话口型 3 个**（`talk/DK_NOZOMU_*.mtn`，均含 PARAM_MOUTH，63 行）：`talk` 组，**配合语音播放**。

- 无镜头推近参数（CAMERA=0，与 app.js 注释"防镜头推近"的既有经验一致——以目测为准）
- 总时长估算：motion1 为 54 帧 @30fps ≈ 1.8s；其余按帧数换算

## 2. 播放机制（API 已验证）

```
model.motion(group, index?, priority?)     // group = flick_head|tap_body|talk|idle（model.json 组名）
  → motionStart / motionFinish 事件        // 播完恢复用
  → 库内建队列（queueManager.startMotion） // 连续调用自动排队，不互相抢占
表情叠加：preserveExpressionOnMotion=true（库默认）→ 动作与表情同时生效（可叠）
```

## 3. 冲突处理（关键：与现有 idle 循环打架）

现状 `app.js:91-96`：`setInterval(25s)` 播 `idle`——自定义动作播放时会被 idle 打断。
方案：**MotionController 统一管理**：
- `playAction(group, index?)`：暂停 idle 定时器 → `model.motion(...)` → 监听 `motionFinish` → 恢复 idle 定时器
- `stopAction()`：清队列 + 回 idle（被打断/用户交互时）
- idle 循环从"裸 setInterval"移入 controller（含防重入：连续 playAction 时 idle 不恢复）

## 4. 情绪 → 动作映射表（配置驱动，先给初版，目测后校准）

```js
// desktop/renderer/motion-map.mjs —— 与表情映射表同一结构，便于四件套合并
export const MOTION_MAP = {
  think:    { group: "flick_head", index: 0, minMs: 1800 },  // 低头思考（面试官提问后）
  agree:    { group: "flick_head", index: 3 },              // 点头同意
  curious:  { group: "flick_head", index: 1 },             // 歪头好奇（CC 陪伴倾听）
  surprise: { group: "flick_head", index: 11 },            // 综合大幅度
  sigh:     { group: "flick_head", index: 10 },            // 转身叹气
  talk:     { group: "talk", index: 0 },                   // 说话口型（配语音）
  idle:     { group: "idle", index: 0 },
};
```
- **index 语义待目测校准**（哪个 motion 到底长什么样，需跑起来逐个看）；映射表先行、校准后填
- 动作与表情/气泡/语音**组合播放**（四件套同时触发：表情叠加、动作独立队列、气泡 2s、语音独立）

## 5. 与语音流水线的衔接（talk 组）

- 语音播放开始时 `playAction("talk")`（口型动），语音结束 `motionFinish` 自动回 idle
- 若语音方案未就绪，先不接（talk 仅作为映射表预留）

## 6. 文件清单

| 动作 | 文件 |
|---|---|
| 新增 | `desktop/renderer/motion-controller.mjs`（playAction/暂停 idle/事件监听）、`desktop/renderer/motion-map.mjs`（情绪→动作配置表） |
| 修改 | `desktop/renderer/app.js`（startIdleMotion 移入 controller；增加 onAction 入口，供 P2 四件套调用） |
| 测试 | `tests/motion-map.test.mjs`（映射表合法性：group 存在于 model.json、index 在组内、无重复语义） |

## 7. 验收

1. 桌宠加载后 `playAction("agree")` → 点头动作播放、不报错、idle 恢复
2. 连续快速调用 `playAction` 不叠加错乱（队列生效）
3. 自定义动作期间 idle 定时器不打断；结束后恢复
4. 表情 + 动作同时播放不冲突（preserveExpressionOnMotion）
5. `npm run build:renderer` + `check:renderer` 通过；现有测试不回归

## 8. 边界（诚实）

- 动作语义表基于**参数推断**，必须先目测校准再定稿（立项第一步：跑起桌宠逐个播 motion1~12 截图确认）
- 12 个动作都是"点头/歪头/转身"尺度，**没有"挥手/鼓掌/摇头拒绝"类**——情绪粒度靠表情+气泡+语音补位
- 不做参数级微调（setParameter 进阶项），不做新动作资产
- tap_body/flick_head 引用同一批文件：**映射只用 index，不依赖组名语义**（组名是交互触发口径，不是动作语义）

---

## 9. 完成后能讲什么

- "桌宠动作层：12+3 个预制动作参数级盘点 → 情绪映射配置表 → 队列/打断/待机恢复纪律"，可讲 file:line（motion-controller + motion-map + 资产参数表）
- 与表情/语音流水线组合成 P2 四件套的完整叙事
