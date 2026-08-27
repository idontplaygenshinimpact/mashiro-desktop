# Phase 实时语音：GPT-SoVITS 句子级流水线 技术方案

> 目标：把"预设语音包随机播放"升级为**真白声线实时合成**——LLM 边说、句子切出即合成、串行播放，达到"动漫里那种 AI 实时语音"的体验。
> 直接继承（2026-08-26 语音优化全部沉淀）：最优参数 top_k=20/top_p=0.85/temp=1.0、ref-clean-2、四维选优、截断对策（短句+尾词校验）、质检体系。
> 与 docs/phase-voice-语音升级流水线-方案.md 的关系：该方案是"播放队列+分层合成"（含 edge-tts 路径）；本方案是**本地 GPT-SoVITS 引擎**实现，两者合并演进（预设命中→缓存→实时合成的分层不变，实时层引擎 = GPT-SoVITS 本地）。

---

## 1. 现状与目标

**现状**：`desktop/tts-edge.mjs` = 预设 wav 关键词匹配 + ack 兜底（内容对不上）；`lib/agent.mjs:705` voice 字段恒空；无实时合成。

**目标形态**：
```
LLM 流式回复（widget chat-stream / study-detail-stream）
  → 渲染层句子切分器（speech-queue）
  → 每句：① voice-pack 预设命中 → 播（零延迟，真白声线资产）
         ② TTS 缓存命中 → 播缓存
         ③ 未命中 → GPT-SoVITS 实时服务（本地，最优参数+ref-clean-2）→ 播+入缓存
  → 串行播放队列（audio-ended 推进、可打断）
  → （可选）talk motion 口型同步（衔接 P2 动作层）
```

**延迟预算（诚实）**：
| 路径 | 首句延迟 | 说明 |
|---|---|---|
| 预设命中 | <10ms | 高频场景保留 |
| 缓存命中 | <50ms | 重复句子零合成 |
| GPT-SoVITS 实时 | **模型热载后每句 0.5~1.5s**（GPU，20-45 字） | 句子级流水线：LLM 首句+合成首句 ≈ 2-3s；**后续句被 LLM 吐字重叠掩盖** |
| 模型冷启动 | 首次 30~60s（加载权重） | 惰性加载 + engine-ready 事件，启动期播预设兜底 |

---

## 2. 服务端：本地 TTS 服务（新 `lib/tts-gpt-sovits.mjs` + `bin/tts-server.mjs`）

### 2.1 形态
- **独立 Node 进程**（`bin/tts-server.mjs`）spawn `py` 推理子进程（复用 GPT-SoVITS 环境），HTTP 服务端口 **8900**（与 widget 8899 分开，互不阻塞）
- 或 widget 内嵌 spawn：**选独立进程**（TTS 推理 CPU/GPU 占用与 widget 隔离；widget 挂了对 TTS 无影响）
- 生命周期：惰性启动（首次请求才加载模型，~30-60s）→ 常驻 → `GET /api/tts/status` → 空闲可回收（env `MIANSHI_TTS_IDLE_RECYCLE_MS`，默认 30min）

### 2.2 API
```
POST /api/tts/synthesize   { text: "≤60字", speed: 1.0 } 
  → { ok, wav: base64, sr: 32000, ms: 合成耗时, cached: false }
POST /api/tts/abort        （清空排队任务）
GET  /api/tts/status       → { loaded, modelMs, queueLen, sinceStart }
```
- **串行锁**：单模型单进程，并发请求排队（队首合成、队尾等待）；`queueLen` 暴露给上层（队列过长时上层降级预设/静音）
- 鉴权：`MIANSHI_TTS_TOKEN`（复用 widget token 模式），仅本机

### 2.3 推理配置（继承实验结论，写死为默认）
```
top_k=20 / top_p=0.85 / temperature=1.0     ← 参数网格最优（+9% 验证，ref-clean-A 下实测）
ref_wav = radio/ref-clean-A.wav             ← 人设温柔风，人耳验证像真白
ref_text = "戻ろうと思って エスカレーターに乗ったの離しちゃダメなの 離したら飛んでくわ"
max_text_len = 60                            ← 短句成功率高（VOICE.md 拆句经验）
```
- ⚠️ **ref 选型教训（2026-08-26 实测）**：ref-clean-2 质量分 +27% 但台词是"男らしくはっきりしないとダメよ"（强硬吐槽语气），合成句带出强硬语气——**机器质量分测不出语气一致性，ref 语气是人设资产，必须人耳验证**。已回滚 ref-clean-A
- 合成质量（服务内）：**不做每句 whisper 校验**（太重，会拖死流水线）——轻量校验 + 抽样深检（见 §3）

### 2.4 Python 推理子进程（`scripts/tts-server-worker.py`）
- 复用 synth-mashiro-long.py 的环境/模型加载（import 顺序坑已记录：GPT_SoVITS 先于 faster_whisper）
- 与 Node 通信：stdin/stdout JSON 行协议（每行一个请求/响应，串行天然）
- 模型加载后发送 `{"event":"ready","ms":...}`

---

## 3. 渲染层：句子切分 + 播放队列（新 `desktop/renderer/speech-queue.mjs`）

### 3.1 句子切分器（规则，零 LLM 成本）
- 输入：流式 delta 累积文本
- 切分：按 `。！？\n`；**句子 <8 字并入下一句**（防碎片，voice-pack 经验）；代码块/URL 行不播
- 输出：完整句 → `queue.speakSentence(句)`

### 3.2 播放队列（串行 + 可打断）
- `speakSentence(text)`：预设命中 → 播（ffplay/HTMLAudio）→ 未命中 → TTS 服务合成 → 播 + 入缓存
- `stopSpeak()`：清队列 + 停当前（用户说话/点击时）
- `audio-ended` 驱动下一句；语音与打字机同步推进
- 缓存：`data/tts-cache/<sha1(句)>.wav`（LRU 上限 200MB，原子写）

### 3.3 校验/重试/降级（截断问题对策，三层）
```
1. 服务端轻校验：合成结果时长阈值（<0.3s 判失败）、音频非空；wav 头合法
2. 客户端重试：失败或超时（>8s）→ 重试 1 次（同句）→ 仍失败 → 降级
3. 降级链：预设 ack → 静音跳过（不阻塞对话流）
（可选增强）抽样深检：每 N 句（默认 20）随机 1 句做 whisper tail 校验（异步、不阻塞播放），
   统计 tail 达标率写日志——实时链路的"质检"就靠这个抽样 + 离线 audit 全量回归
```

---

## 4. 集成点

| 文件 | 改动 |
|---|---|
| 新增 `lib/tts-gpt-sovits.mjs` | 服务客户端（synthesize/abort/status，Bearer） |
| 新增 `bin/tts-server.mjs` | 独立进程入口（spawn python worker + HTTP 8900） |
| 新增 `scripts/tts-server-worker.py` | 推理子进程（复用 synth 环境与参数） |
| 新增 `desktop/renderer/speech-queue.mjs` | 切句 + 队列 + 打断 + 缓存 + 降级 |
| 修改 `desktop/renderer/panel-chat.js` | 流式回调接切句器（`chatStream` onChunk → queue） |
| 修改 `desktop/renderer/app.js` | 桌宠气泡文本同步走 queue（衔接 petSay） |
| 修改 `desktop/main.mjs` | spawn/守护 tts-server（复用 widget-server 守护模式）；`window:speak` 兼容 |
| 修改 `desktop/tts-edge.mjs` | speak() 增加"实时合成"分支（预设→缓存→实时→ack） |
| env | `MIANSHI_TTS_ENABLED`（默认 1）、`MIANSHI_TTS_PORT=8900`、`MIANSHI_TTS_IDLE_RECYCLE_MS`、`MIANSHI_TTS_BUDGET`（日上限 200 句，超限降级预设） |
| 测试 | `tests/speech-queue.test.mjs`（切句/打断/缓存/降级纯函数）、`tests/tts-client.test.mjs`（mock 服务） |

---

## 5. 与现有能力的衔接

- **voice-pack 预设**：保留最高优先级（高频场景零延迟 + 真白声线资产）；实时合成只补"内容对得上"的空缺
- **P2 动作层**：播放开始 → `talk` motion（口型），audio-ended → 回 idle——预留接口
- **质检体系**：离线 `audit` + `score` 继续管存量资产；实时链路用"抽样深检 + 延迟采样"
- **评测体系**：`scripts/bench-speech-latency.mjs` 记录 P50/P95 首句延迟（三路径分桶）——并入 eval_summary

---

## 6. 验收标准（可测）

1. `curl POST :8900/api/tts/synthesize {"text":"こんにちは"}` → 返回合法 wav（时长>0.3s），模型冷启动后 `status.loaded=true`
2. 连续 10 句不同文本合成：均成功、单句耗时 <3s（GPU 热载）、串行不串音
3. 面板对话：发一条消息 → 语音与文字同步（预设命中即时、合成句 2-3s 内出）；内容与回复一致
4. 打断：连续快速发两条 → 第一条被停、只播第二条
5. 降级：停掉 tts-server → 对话不卡死（预设/静音兜底）+ 日志告警
6. 截断对策：抽样深检 tail 达标率 ≥90%（与离线 audit 阈值对齐）
7. 回归：现有 `npm test` 全绿、`npm run dist` 打包通过（新模块进 esbuild bundle）

---

## 7. Wave 与工作量

| Wave | 内容 | 工作量 |
|---|---|---|
| W1 | tts-server（worker + HTTP + 串行 + 状态）+ 客户端 lib + mock 测试 | 1.5~2 天 |
| W2 | speech-queue（切句/队列/打断/缓存/降级）+ 面板接线 + 测试 | 1~1.5 天 |
| W3 | 守护集成（main.mjs）+ 抽样深检 + 延迟采样 + 文档 | 1 天 |

---

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 冷启动 30-60s 体验差 | 惰性加载 + 启动期预设兜底 + engine-ready 事件；桌面启动时预热（可选） |
| GPU 常驻占用 | 空闲回收（30min）；与 widget 分进程互不阻塞 |
| 并发句排队延迟堆积 | queueLen 暴露；>3 句时上层降级预设/静音（budget 控制） |
| 尾词丢失（截断遗留） | 短句（≤60 字）+ 重试 + 抽样深检（90% 达标线）；顽固文本走预设/改文案 |
| 合成句音色漂移 | 固定 ref-clean-2 + 固定参数（实验最优）+ 四维选优仅在离线批量用；实时接受"参数固定的一致性" |
| python worker 崩溃 | 守护重启（widget-server 同款 ensure 模式）+ 失败降级 |

---

## 9. 完成后能讲什么（简历/面试）

- **句子级流水线实时语音**：LLM 流式 → 规则切句 → 本地 GPT-SoVITS 合成（最优参数/ref 有实验数据支撑）→ 串行队列播放，首句延迟 P50/P95 实测
- **工程决策链**：被"整批合成延迟大"坑过 → 流水线重叠解决 → 截断对策（短句+抽样深检）→ 质量实验（参数/ref 网格 27+6 组）→ 降级链与预算——每一步有数据
- **真白声线实时化**：从"预设包随机播放"到"内容对得上的实时语音"，桌宠陪伴感质变
