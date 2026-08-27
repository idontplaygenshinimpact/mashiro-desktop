# Phase 语音升级：从"预设随机播放"到"句子级实时流水线" 技术方案

> 背景：当前语音 = 预设 wav 关键词匹配（`desktop/tts-edge.mjs`：matchVoicePack 命中播预设日语 wav，未命中播 ack）。当初弃用实时合成的理由是"延迟大、内容对不上"。
> 结论先行：**"延迟大"的真实原因是"等整篇回复完成后才合成"（非流水线），不是实时合成不可行**——LingChat 证明句子级流水线（LLM 边说 → 切句 → 每句立即合成/播放）可以把延迟压到"首句延迟"，后续句子全部被 LLM 生成时间掩盖（证据：generator.rs:773 每句调用 generate_voice_files、producer.rs 切到即投递）。
> 本方案：**保留预设包资产（零延迟声线），叠加句子级流水线实时合成（内容对得上），分层缓存控制成本**，分四阶段落地。

---

## 1. 现状盘点（已核实）

| 项 | 现状 | 证据 |
|---|---|---|
| 语音入口 | `speak(text)`：matchVoicePack 关键词匹配场景 → 播预设 wav；未命中 → ack 兜底 | desktop/tts-edge.mjs:7-26 |
| 预设资产 | GPT-SoVITS 真白声线 wav + 场景（focus/ack/长句等），scripts 有 synth/score/audit 全套 | desktop/voice-pack.mjs、scripts/voice* |
| voice 字段 | `lib/agent.mjs:705` 恒空（注释"不再由 LLM 生成语音稿，省开销"） | lib/agent.mjs |
| 调用点 | 面板 `panel-chat.js:151`：`speak(r.voice || r.reply || msg)`；桌宠场景由 `petSay` 走 voice-pack | desktop/renderer/panel-chat.js |
| 流式已有 | `/api/chat-stream`、study-detail-stream 已流式输出（delta 事件） | lib/routes/core.mjs:144-172 |
| 引擎资产 | `@andresaya/edge-tts`（依赖仍在）、`sherpa-onnx-node`（ASR 在用）、ffplay（播放） | package.json、voice-pack.mjs:147 |

**痛点**：① 播报内容与当前回复**不对应**（预设句+ack）；② 场景覆盖有限，新场景要人工合成 wav；③ 语音"随机感"损伤陪伴感。

---

## 2. 升级架构：三层（对齐 LingChat 机制，保留我们资产）

```
                  ┌─────────────────────────────────────────────┐
   LLM 流式回复   │  渲染层句子切分器（新）                        │
   (delta 流) ──▶ │  累积 → 按 。！？；\n 切完整句 → 投递句子队列 │
                  └─────────────────────────────────────────────┘
                                     │ 每句到达（不等全文）
                                     ▼
                  SpeechQueue（新，串行播放）
                    │ ① matchVoicePack(句) 命中？ → 播预设 wav（零延迟，保留真白声线资产）
                    │ ② 未命中 → TTS 缓存(句 hash) 命中？ → 播缓存 wav（零合成）
                    │ ③ 未命中 → 实时合成（edge-tts 优先；本地 sherpa 可选）→ 播 + 入缓存
                    ▼
                播放（ffplay/HTMLAudio）；audio-ended 驱动队列下一句
```

**三层目标**：
- **延迟层**：预设命中 ≈0ms；缓存命中 ≈0ms；实时合成首句 = LLM 首句 + 单句网络合成（edge ~0.3-1.5s）——后续句全被 LLM 吐字 overlap
- **内容层**：播报 = 当前回复的真实句子（解决"内容对不上"）
- **成本层**：不引入额外 LLM 调用（句子切分是规则）；合成只在"预设未命中且缓存未命中"时发生，可设日上限

---

## 3. 阶段落地

### 阶段 0（0.5~1 天）：播放队列 + 分层合成（最小改动，先解决"内容对不上"）
- **新增 `desktop/renderer/speech-queue.mjs`**（渲染层模块，esbuild 打包进 bundle）：
  - `speakSentence(text)`：入队串行播放；`stopSpeaking()` 打断（清队列+停当前）；`audio-ended` 驱动下一句
  - 播放顺序保证 + 日志（trace 谁说了什么）
- **`tts-edge.mjs` 改造**：speak() 增加返回"未命中"路径——当前已回退 ack，改为 **ack 之外再尝试实时合成**（edge-tts 已装）：
  ```js
  // speak(text) 新语义：
  //   matchVoice 命中 → 播预设（原行为）
  //   else → cache 命中 → 播缓存
  //   else → edgeTts 实时合成（async）→ 播 + 写缓存   [env: MIANSHI_SPEECH_REALTIME=0 关闭回退]
  ```
- **缓存**：`data/tts-cache/<sha1(句)>.mp3`（原子写，容量上限清理，复用 atomic-json 思路）
- 面板调用点 `panel-chat.js:151` 从"一次性 speak(整段)"改为 `speakSentences(整段)`（内部切句入队）——**渲染层切分器（阶段 1 同款）先行**

### 阶段 1（1~2 天）：句子级流水线（对齐 Ling 机制，核心）
- **渲染层句子切分器**（`speech-queue.mjs` 内）：流式回调（现有 `chatStream` 的 onChunk）累积文本 → 按 `[。！？；\n]` 切出完整句 → 完整句即 `speakSentence(句)`（进队列）
- 切分细则：句子最小长度（<8 字并入下一句，避免碎片）；代码块/URL 行不播（噪音过滤）；句尾语气词剥离（播读友好）
- **面板与桌宠统一**：`panel-chat` 与 `app.js`（桌宠气泡）共用同一 `speech-queue`（桌宠侧读 `pet-say` 事件的 text 也走同一队列）
- 收益：对话中语音与文字同步（打字机+语音同推进），内容实时对上
- **测试**：`tests/speech-queue.test.mjs`（切分规则纯函数：完整句/碎片合并/噪音过滤/打断语义）

### 阶段 2（2~3 天，可选）：本地合成引擎（延迟对标）
- **sherpa-onnx TTS**（`sherpa-onnx-node` 已在依赖）：中文 vits 模型（~50-200MB）进程内合成
  - 单句 ~0.1-0.3s（无网络 RTT），串行锁 + 惰性初始化（对标 Ling 的 LocalTtsEngine 模式：`tts://engine-ready` 事件思想 → 我们的 `speech:tts-ready`）
  - 服务端（widget 进程）跑（`lib/speech-tts.mjs` 新模块），渲染层经 IPC/HTTP 调用
- 用途：edge-tts 网络失败/离线时的兜底 + 低延迟主通道（可配置优先级 edge 优先 or sherpa 优先）
- **注意诚实点**：sherpa 通用中文音色 ≠ GPT-SoVITS 真白声线；预设命中场景仍优先真声线，实时场景接受通用音色——"内容正确性 > 声线一致"

### 阶段 2（可选）：voice 字段回归与语句级 TTS 文本
- `lib/agent.mjs` 的 voice 字段：**不回归** LLM 生成语音稿（省成本）；句子切分器天然解决"播什么"
- 如需"播读友好化"（口语化/缩短），可后续做"规则化语音稿"（抽句子 + 缩句规则），而非 LLM

---

## 4. 延迟预算（诚实数字）

| 路径 | 首句延迟 | 句间隔 | 说明 |
|---|---|---|---|
| 预设命中（场景句） | <10ms | ~0 | 保留现有资产，覆盖高频场景 |
| 缓存命中 | <50ms | ~0 | 重复讲过的句子零合成 |
| edge-tts 实时（默认） | ~0.3-1.5s（网络+合成） | 被 LLM overlap 掩盖 | 首句可感知，后续几乎无感 |
| sherpa 本地（阶段 1 可选） | ~0.1-0.3s | 被 overlap 掩盖 | 对标 Ling 的本地引擎体验 |

**验收口径**：`首句延迟 = LLM 首句 + 合成首句`；**持续对话中无感延迟**（LLM 还在吐时语音已在播）——这个口径要写进评测。

---

## 5. 成本与安全控制

- **无额外 LLM 调用**（切分/合成都是本地规则+合成器，不含 LLM 请求）——评测体系成本模型不变
- **合成频率上限**：`MIANISH_SPEECH_REALTIME_BUDGET`（默认 60 句/日，超限自动降级预设/静音）
- **缓存容量上限**：`MIANISH_TTS_CACHE_MAX`（默认 200MB，LRU 清理）
- **中断控制**：用户说话/点击时 `stopSpeak()` 立断，不堆积队列
- **失败降级**：合成器错误 → 静默跳过该句（不阻塞对话），与现有 ack 行为兼容

---

## 6. 验收标准（可测）

1. `tests/speech-queue.test.mjs`：切分/合并/过滤/打断全绿
2. 真实对话：发一条回复 → 面板语音与文字同步；**播报内容 = 回复句子**（不是预设/随机）
3. 延迟采样：脚本 `scripts/bench-speech-latency.mjs`（可选）记录 P50/P95 首句延迟（预设/缓存/实时三路径分桶）——并入评测体系 eval_summary 新列
4. 成本：连续对话 10 轮，实时合成调用 ≤ 上限且缓存命中率 >30%（诚实目标）
5. 回归：现有 `npm test` 全绿；`check:renderer` 通过（bundle 新模块打包成功）；桌宠 petSay 行为不变（预设优先）

---

## 7. 文件清单

**新增**
- `desktop/renderer/speech-queue.mjs`（切分器 + 串行队列 + 打断）
- `lib/speech-tts.mjs`（阶段 1：sherpa 本地合成服务端模块；阶段 0 先不建）
- `tests/speech-queue.test.mjs`、`scripts/bench-speech-latency.mjs`
- `data/tts-cache/`（缓存目录，gitignore）

**修改**
- `desktop/tts-edge.mjs`（speak 三路径：预设 → 缓存 → 实时合成，env 开关）
- `desktop/renderer/panel-chat.js:151`（调用点改队列化句子播报）
- `desktop/preload.js`（暴露 `speakSentences`/`stopSpeak` 或复用现有 speak + 新队列参数）
- `desktop/main.mjs`（`window:speak` 透传保持 + `stopSpeak` 通道）
- `package.json`（scripts：`speech:bench`；env 文档化）

---

## 8. 边界与诚实说明

- **不承诺"和 LingChat 一样低"**：Ling 是本地引擎+日语短句；我们是网络合成为主，首句 ~0.3-1.5s 是物理下限；**体验目标是"首句可接受、持续无感"，不是"秒回"**
- **声线一致 vs 内容一致**：预设命中（高频场景）保真声线；实时路径用通用音色——决策明确：内容正确优先
- 阶段 1（本地引擎）若 sherpa 中文音色质量不佳 → 回退 edge-tts 并如实记录评测
- 这轮升级**不碰** TTS 适配器工厂/模型管理 UI（那是 Ling 借鉴的另一条线，先不做）

---

## 9. 完成后能讲什么（简历/面试）

- "把随机预设语音升级为**句子级流水线**：LLM 流式 → 规则切句 → 预设/缓存/实时合成三层路径 → 串行队列播放，首句延迟预算实测（P50/P95），合成调用有日预算与 LRU 缓存"——机制可讲、数据可测
- 与"当时放弃实时合成的历史"形成完整决策链：被延迟坑过 → 查证根因（整批合成 vs 流水线）→ 分层架构解决 → 评测验证——**这是教科书式的工程决策叙事**