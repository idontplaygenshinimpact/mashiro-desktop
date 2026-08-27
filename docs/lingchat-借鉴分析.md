# LingChat 借鉴分析：实时语音合成思路 + 桌宠交互增强

> 分析对象：[SlimeBoyOwO/LingChat](https://github.com/SlimeBoyOwO/LingChat)（Tauri + Vue3 + Rust，沉浸式 AI-Galgame 聊天 + 桌宠 + 日程 + 剧情）
> 对比对象：本仓库 真白 Mashiro（Electron + Live2D 桌宠 + widget 后端 + MCP）
> 源码快照：`%TEMP%\lingchat-research`（shallow clone，已删除可重新 clone）

---

## 一、LingChat 实时语音合成：思路拆解

### 1.1 核心链路：分段情感合成 + 顺序播放（最重要的思路）

不是"整段回复一次合成"，而是：

```
LLM 回复带结构化标记：【情绪】正文<日语>（动作）【情绪】正文<日语>（动作）…
        │
        ▼
processor.rs: parse_and_classify_emotional_segments()
  正则切段 → EmotionSegment[] { 情绪标签, 显示文本, ttsText(日语), 动作, 语音文件路径 }
        │
        ▼
voice_maker.rs: generate_voice_files(segments)
  每段并发合成（join_all），一段一个音频文件，单段失败只记日志不阻塞整批
        │
        ▼
前端顺序播放：watch currentAvatarAudio → getVoiceAudio(base64) → audio.play()
  → @ended → 播放下一段（打字机同步显示正文）
```

三个关键设计：

1. **分段即边界**：每个情绪段是"显示 + 语音 + 表情 + 动作"的最小单元，四者天然同步，不用后期对齐。
2. **并发合成、串行播放**：段落间用 `join_all` 并发请求（各家 TTS 后端 RTT 长），播放端按队列顺序播；音频结束事件（`audio-ended`）驱动交互推进（见桌宠部分）。
3. **ttsText 与显示文本分离**：朗读用日语短句，显示用中文——**朗读文本 ≠ 显示文本**，TTS 只念适合念的短句。

### 1.2 可插拔 TTS 适配器工厂（TtsProvider + Adapter 模式）

`src-tauri/src/ai_service/tts/voice_maker.rs` + `provider.rs`：

- 9 种后端适配器：VITS / SBV2 / SBV2API / GPT-SoVITS / AIVIS / OpenTTS(CosyVoice) / FishS2 / IndexTTS2 / 本地 SBV2 ONNX
- 每个角色配置 `tts_type`，启动时 `check_tts_availability()` 按配置非空判断可用性，不可用则 `provider.disable()`
- 失败降级链：本地引擎全局关闭 → 自动切独立配置的**云端 fallback**（`localsbv2api → sbv2api`）；被禁用后 `recover_in_background()` 在后台尝试恢复
- 情绪分类器的预测标签（emo）随请求传给适配器（IndexTTS2 / FishS2 消费 emo 参数，其余忽略）

### 1.3 本地 TTS 引擎生命周期管理（SBV2 ONNX 进程内）

`src-tauri/crates/sbv2-local-tts` + `docs/local-tts-api.md`（文档非常完整，值得抄作业）：

- 不监听端口，Rust crate 进程内推理：DeBERTa（BERT 文本编码）+ 语音 ONNX + style_vectors
- **生命周期协议**：启动时后台预加载 → `tts://engine-ready` 事件；首次合成时惰性初始化；`async Mutex` 串行锁保护模型 Holder（多段并发合成不会同时取走模型）
- **模型管理**：目录 catalog（deberta / voices / style_vectors 三类资产）→ 下载（`.part` 临时文件 + 成功后改名、进度事件 200ms 或 1MiB 节流）→ 文件路径导入 / 压缩包导入 → 删除（带安全命名约束 + 目录穿越检查）→ 状态查询 `{ ready, deberta_installed, installed_voice_count }`
- 状态语义明确：`deberta_installed: true ≠ ready: true`（可能仍在后台初始化）

### 1.4 播放与音频设备管理

- `src/utils/audioOutputManager.ts`：全局输出设备切换——`MutationObserver` 捕获新增 `<audio>` + 包装 `Audio`/`AudioContext` 构造器 + 补丁 `play()`，全部播放路径统一应用 `setSinkId`；设备热插拔 `devicechange` 自动刷新；缺用户激活时挂 `pointerdown/keydown` 一次性重试
- 音频以 base64 data URL 经 Tauri IPC 传输（`getVoiceAudio`），无本地文件暴露

---

## 二、LingChat 桌宠交互增强：思路拆解

### 2.1 核心：透明窗口 + solid-region 精确点击穿透

`src-tauri/src/api/pet.rs` + `src/components/views/PetMode.vue`：

- 桌宠模式：frameless + transparent + alwaysOnTop + skipTaskbar，窗口尺寸按组件实时计算（`240*scale` 头像 + 气泡区 + 输入区）
- **100ms 间隔**计算"实心矩形"列表推给 Rust（`update_solid_regions`）：
  - 头像圆环：**常驻** solid（保证可拖拽、可点击）
  - 对话气泡：**仅 responding 且有内容时**加入（用气泡精确 rect，不包住整个对话框）
  - 输入框：显示时加入（外扩 20px 保证极小尺寸下鼠标判定连贯）
- 效果：**桌宠区域可交互，其余区域鼠标直接穿透到桌面**——比"整体 `setIgnoreMouseEvents(forward)`"精细得多，拖拽与点击不再互相打架

### 2.2 hover 操作环

头像 hover 时在左侧滑出 4 个 backdrop-blur 圆钮：设置 / 自动播放(⏯) / 返回主页 / 截图；opacity+translate 过渡，不 hover 自动隐藏，不遮挡桌宠本体。

### 2.3 对话推进交互（打字机 + 音频驱动）

- 气泡正文打字机逐字显示（TypeWriter，普通 div 需提供 writeFn）
- 点击气泡 / 点击头像 = 继续下一句（`eventQueue.continue()`）
- **音频播放结束**（`audio-ended`）→ 自动推进下一段；自动模式（autoMode）下：打字完成 && 音频结束 → 1 秒延时 → 继续
- 气泡上方显示当前情绪标签（斜体青色小字），情绪随分段切换

### 2.4 独立轻量设置窗口 + 双向事件

- 桌宠模式下点设置 → 打开独立 `WebviewWindow('settings')`（透明无边框），与主窗口事件互通：`pet-scale-changed` / `pet-volume-changed` / `background-effect-changed` / `request-dialog-history`
- 桌宠比例、音量、背景特效在设置窗调整，桌宠窗口实时响应（`set_pet_mode` 重建窗口尺寸）

### 2.5 文件拖放投喂

`useFileDrop`：文件直接拖到桌宠上触发动作（Galgame 里是"喂角色看文件"），拖拽中桌宠显示高亮态。

---

## 三、我们项目现状对照

| 能力 | LingChat | 真白 Mashiro（现状） | 差距 |
|---|---|---|---|
| 回复→语音 | 分段并发合成 + 串行播放，ttsText 独立 | `lib/agent.mjs:705` 返回 `voice: ""`（曾让 LLM 生成语音稿，为省开销已停）；`desktop/tts-edge.mjs` 走**预设 wav 关键词匹配**，未命中播 ack；面板 `panel-chat.js:151` 播 `r.voice \|\| r.reply` | 语音与内容不对应（代码注释自认"内容对不上"） |
| 语音引擎 | 多适配器 + 本地 ONNX 引擎 | 只有 voice-pack 预设 + ffplay；ASR 已有 sherpa-onnx（`speech-worker`/`vad.js`/`pcm-worklet.js` 齐备） | TTS 无本地引擎、无适配器层 |
| 模型管理 | catalog/下载/导入/删除/进度事件/状态机 | ASR 模型有 `scripts/download-paraformer.mjs`，无 UI、无进度 | 缺管理协议与 UI |
| 桌宠窗口 | solid-region 精确穿透 | `transparent + frame:false + alwaysOnTop` + `setIgnoreMouseEvents(true,{forward:true})` **整体穿透**（main.mjs:1066） | 整体穿透 → 桌宠本体不可点；拖拽靠特殊区域 |
| 交互入口 | hover 操作环 + 点击气泡推进 + 文件投喂 | 右键菜单（`mascot:menu`）+ 托盘 + 面板 | 少 hover 快捷环、少文件投喂 |
| 情绪表达 | LLM 分段情绪 → 表情/标签/TTS 参数 | `lib/emotions.mjs` 只有"稀缺情绪峰值"设计（无 LLM 联动） | 情绪未接入回复管线 |
| 播放体验 | 打字机 + 音频结束驱动推进 + 设备切换 | 一次性播放预设 wav | 无队列、无推进交互 |

---

## 四、可借鉴点分级清单

### A. 直接做（高价值、低成本，1~2 天）

1. **语音稿回归 + 分句合成播放队列**
   - `lib/agent.mjs` 的 `voice` 字段已存在（空串），把"LLM 生成短语音稿"加回来（**面试场景特别值**：面试官朗读口语短句，面板显示完整追问）
   - 渲染层做播放队列：整段回复按句切分 → `voice-pack` 关键词命中优先（零延迟）→ 未命中才走实时合成（edge-tts 单句 0.3~1s，首句延迟可接受）→ 上一段 `ended` 再播下一段
   - 完美解决"内容对不上"且保留常用场景零延迟

2. **气泡打字机 + 点击继续 + 音频结束自动推进**
   - 桌宠气泡与面板对话复用同一套：打字中可点击跳过、音频播完自动出下一段

3. **ASR 模型管理 UI 化**（抄 local-tts-api 的协议）
   - 状态 `{ready, installed, count}`、下载进度事件（200ms/1MiB 节流）、`.part` + 改名、删除带命名约束——现有 `download-paraformer.mjs` 直接升级

### B. 值得做（2~5 天）

4. **TTS 适配器工厂**（抄 VoiceMaker）
   - `voice-pack` / edge-tts / sherpa-onnx TTS 三个适配器 + availability 检测 + 降级链（预设包 → 实时 → ack）
   - 设置页可视化选择声线与优先级

5. **sherpa-onnx 本地 TTS 引擎**（对标 LocalTtsEngine）
   - `sherpa-onnx-node` 已在依赖里（ASR 在用），其 TTS 模型（vits-zh 等）进程内合成，完全离线；串行锁 + 惰性初始化 + 首次合成前预加载
   - 不需要 LingChat 那种多 GB 的 SBV2 + DeBERTa，sherpa 单模型几百 MB 量级

6. **分段情绪联动**（对标 EmotionSegment）
   - 面试官回复带轻量标记（如 `【追问】…【满意】…`），驱动：气泡情绪标签 + Live2D 表情 + 可选 TTS 参数；保留 `emotions.mjs` 的稀缺性设计（日常不常开，任务节点才露峰值）

### C. 桌宠交互增强（移植思路，2~3 天）

7. **solid-region 精确点击穿透**（性价比最高的一条）
   - 替代整体 forward 穿透：头像常驻 solid、气泡显示时加入、面板打开时加入；拖拽/点击/穿透三不误

8. **hover 操作环**：设置 / 静音 / 自动播放 / 退出四个圆钮，hover 滑出（右键菜单保留）

9. **文件拖到桌宠**：简历 / 面经 md 直接拖到真白 → 走已有 `resume:parse-file` / `import:parse-file` IPC → 加入面试准备——对面试助手是强场景交互

10. **设置小窗独立**（可选）：桌宠模式下设置抽到独立透明小窗，双向事件调 scale/音量（我们已有 panel 窗口，改造即可）

### D. 不建议 / 暂缓

- SBV2 + DeBERTa 本地大引擎（Rust crate + 多 GB 模型，Node 生态成本高；sherpa TTS 足够）
- 多语言 ttsText（日语朗读）——场景不需要
- 截图投喂、成就系统、日程/剧情——与面试助手场景无关

---

## 五、落地路线（建议顺序）

```
Phase 1（1~2 天）A1+A2：语音稿回归 + 播放队列 + 气泡推进交互
  改动：lib/agent.mjs（voice 字段）、desktop/tts-edge.mjs（分句+队列）、渲染层气泡
Phase 2（2~3 天）C7+C8+C9：solid-region 穿透 + hover 环 + 文件拖放
  改动：desktop/main.mjs（穿透协议）、桌宠渲染层
Phase 3（3~5 天）B4+B5+A3：TTS 适配器工厂 + sherpa 本地引擎 + 模型管理 UI
  改动：lib/speech* 扩展、设置页
Phase 4（可选）B6：分段情绪联动（面试官表情）
```

---

## 六、参考文件索引

**LingChat**（`%TEMP%\lingchat-research`，或 [GitHub](https://github.com/SlimeBoyOwO/LingChat)）：
- TTS 分段管线：`src-tauri/src/ai_service/message_system/processor.rs`（EmotionSegment 解析）、`src-tauri/src/ai_service/tts/voice_maker.rs`（并发合成）、`src-tauri/src/ai_service/tts/provider.rs`（适配器工厂）
- 本地引擎：`src-tauri/crates/sbv2-local-tts/`、`docs/local-tts-api.md`（协议文档范本）
- 播放与设备：`src/utils/audioOutputManager.ts`、`src/components/pet/GameRolesStage.vue`
- 桌宠：`src-tauri/src/api/pet.rs`（solid regions）、`src/components/views/PetMode.vue`、`src/components/pet/DialogueBox.vue`、`GameRoleAvatar.vue`、`DragArea.vue`、`useFileDrop.ts`

**本仓库**：
- 语音：`desktop/tts-edge.mjs`、`desktop/voice-pack.mjs`、`lib/agent.mjs:705`（voice 字段）、`lib/speech.mjs`、`desktop/speech-worker.mjs`
- 桌宠窗口：`desktop/main.mjs`（createWindow:141、window:set-ignore:1066、mascot:menu:308）
- 交互：`desktop/renderer/panel-chat.js:151`（speak 调用点）

---

## 七、补读（表达渲染管线 P2 素材）：表情渲染 + 情绪分类

> 补读时间：事件驱动内核方案之后，为 P2 表达渲染管线收集素材。文件仍在 `%TEMP%\lingchat-research`。

### 7.1 情绪 → 表现四件套映射表（GameRoleAvatar.vue + config.ts）

LingChat 的情绪表达是**配置表驱动**，一个情绪对应四件事（`EMOTION_CONFIG[emotion]`）：
1. **头像表情图**（`resolveAvatar()`：emotion + clothesName → `get_avatar_file` → 表情图，ImageCrossFade 交叉淡入淡出切换，防闪烁技巧见注释）
2. **动画 class**（`config.animation`，`animationend` 后回 `normal`）
3. **气泡图片**（`config.bubbleImage` + bubbleClass，2 秒超时自动隐藏）
4. **音效**（`config.audio`，音量跟"气泡音量"设置）

关键实现细节（直接可抄）：
- **竞态保护**：`latestEmotionId` 计数器——快速连续切情绪时，只应用最后一次（我们 Live2D 表情切换同样需要）
- **思考态独立反馈**：`currentStatus === 'thinking'` 走独立的"AI思考"气泡+音效，与情绪解耦（不是情绪，是状态）
- **防闪烁**：移除 `?t=` cache-buster（本地资源重载导致闪烁）

### 7.2 情绪分类双通道（classifier.rs，ONNX 本地模型）

- **本地 BERT ONNX 分类器**（字符级 + 线性头，seq_len 128，ONNX Runtime）——情绪分类**不调 LLM，零成本离线**；置信度阈值极低（0.08，基本必出结果）
- **direct passthrough**：输入文本本身就是合法情绪标签时直接透传（`ENABLE_DIRECT_EMOTION_CLASSIFIER`）——**LLM 出标签 + 本地模型兜底**双通道：LLM 输出带 `【开心】` 标记直接用；没标记才走本地分类器
- **disabled 降级**：模型缺失时 `label = 输入原文`（透传），链路不崩

### 7.3 对我们 P2（表达渲染管线）的直接映射

| LingChat 机制 | 我们的对应物 | 结论 |
|---|---|---|
| EMOTION_CONFIG 四件套映射表 | `emotions.mjs`（稀缺峰值设计）+ `voice-pack.mjs`（场景→wav）+ Live2D（expression/motion 可程序播放） | **抄配置表模式**：emotion → {Live2D expression, 气泡文案, voice-pack 场景, 音效} 四件套；Live2D 替代表情图 |
| LLM 出标签 + 本地兜底 | `lib/agent.mjs` 现剥掉【语音】标记；`emotions.mjs` 是规则式 | P2 可加【情绪】标记（LLM 直出标签），本地规则兜底；**本地 ONNX 分类器是可选项**（sherpa-onnx 已在依赖，但先不做，避免范围膨胀） |
| 竞态保护 latestEmotionId | 无 | 抄：Live2D 表情/气泡切换加序号防竞态 |
| 思考态独立反馈 | 无 | 抄：'thinking' 状态 → 独立气泡+音效，与情绪解耦 |
| 情绪气泡 2s 自动隐藏 | 桌宠气泡已有 | 对齐行为 |
