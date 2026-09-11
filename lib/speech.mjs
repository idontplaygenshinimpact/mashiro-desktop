// lib/speech.mjs —— 语音输入识别（本地离线 ASR，零 API key）
// 引擎（SPEECH_ENGINE 可配，默认 sherpa）：
//   sherpa  : sherpa-onnx paraformer-zh（中文 SOTA 级、CPU 实时率 5x+，模型 ~230MB）
//   whisper : transformers.js whisper-small（fallback；WASM 慢，仅当 sherpa 不可用时兜底）
// 注意：推理必须跑在 worker 线程（lib/speech-worker.mjs 容器）——同步计算放主进程
//       会阻塞 Electron 整个应用（历史卡顿根因）。
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = (process.env.SPEECH_ENGINE || "sherpa").toLowerCase();
const MODEL_DIR = path.join(ROOT, "models", "sherpa-onnx-paraformer-zh");
const MODEL_ONNX = path.join(MODEL_DIR, "model.int8.onnx");
const MODEL_TOKENS = path.join(MODEL_DIR, "tokens.txt");
const MODEL_MISSING_HINT = "scripts/download-paraformer.mjs"; // 错误信息标记，上层据此给用户提示

// ---------- sherpa-onnx paraformer-zh（默认引擎） ----------
let recognizerPromise = null; // 单例（懒加载 + 缓存；失败重置可重试）

function getSherpaRecognizer() {
  if (!recognizerPromise) {
    recognizerPromise = (async () => {
      if (!existsSync(MODEL_ONNX) || !existsSync(MODEL_TOKENS)) {
        throw new Error(`缺少本地 ASR 模型（${MODEL_DIR}），请先运行: node ${MODEL_MISSING_HINT}`);
      }
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const sherpa = require("sherpa-onnx-node");
      return new sherpa.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          paraformer: { model: MODEL_ONNX },
          tokens: MODEL_TOKENS,
          numThreads: 2, // CPU 多线程
          provider: "cpu",
          debug: 0,
        },
      });
    })().catch((e) => {
      recognizerPromise = null; // 失败重置：允许后续重试
      // 标记为"加载阶段失败"（模块 require/构造/模型缺失）——上层据此统一回退 whisper；
      // 识别运行期（decode/getResult）抛错不带此标记，仍按识别失败返回
      const err = e instanceof Error ? e : new Error(String(e));
      /** @type {any} */ (err).sherpaLoadFailed = true;
      throw err;
    });
  }
  return recognizerPromise;
}

/** paraformer 离线识别（16kHz mono Float32Array → 文本） */
async function transcribeSherpa(audio) {
  const recognizer = await getSherpaRecognizer();
  const stream = recognizer.createStream();
  try {
    stream.acceptWaveform({ samples: audio, sampleRate: 16000 });
    recognizer.decode(stream);
    const text = (recognizer.getResult(stream)?.text || "").trim();
    if (!text) return { ok: false, error: "未识别到语音内容" };
    return { ok: true, text };
  } finally {
    try { stream.free?.(); } catch { /* ignore */ }
  }
}

// ---------- transformers.js whisper-small（fallback 引擎） ----------
const ASR_MODEL = process.env.SPEECH_ASR_MODEL || "Xenova/whisper-small";
let asrPromise = null;

function getWhisperASR() {
  if (!asrPromise) {
    asrPromise = (async () => {
      const { pipeline, env } = await import("@xenova/transformers");
      env.remoteHost = process.env.HF_ENDPOINT || "https://hf-mirror.com/"; // 国内镜像
      return await pipeline("automatic-speech-recognition", ASR_MODEL, { quantized: true });
    })().catch((e) => {
      asrPromise = null; // 失败重置：允许后续调用重试（如网络恢复后）
      throw e;
    });
  }
  return asrPromise;
}

async function transcribeWhisper(audio) {
  const asr = await getWhisperASR();
  // 强制中文 + transcribe 减少幻觉；chunk_length_s=30 让长句自动分块（whisper 原生 30s 窗口，不切块会丢后半段）
  const out = await asr(audio, { language: "chinese", task: "transcribe", chunk_length_s: 30 });
  const text = (out?.text || "").trim();
  if (!text) return { ok: false, error: "未识别到语音内容" };
  return { ok: true, text };
}

// ---------- 长音频分段（真实面试回答 60-90s 带思考停顿） ----------
// 实测（scripts/_asr-ab.mjs，90.5s「边想边说」音频）：
//   整段送离线 paraformer → 跨句串位/丢句（"模拟面试系统它是整个项目的核心模块" 被识别成
//   "模拟面繁请求为是整个项目的核心模块"——把后面一句的"频繁请求"串到前面，且重复整句），CER 5.5%；
//   按能量谷切段逐段识别 → 句子顺序与内容正确，CER 4.5%，耗时 6.8s → 3.3s（减半）。
// 原因：离线 paraformer 面向单句（训练区间 ~20s 内），多句+长静音整段送入会让注意力跨句错配。
// 另两个假设已被实验排除：71.8s 连续长音频（CER 4.4%、无截断）、极低音量 -22.6dBFS（CER 4.4%）。
const SEG_MAX_SEC = Number(process.env.SPEECH_SEG_MAX_SEC) || 14; // 单段上限（秒）

/**
 * 按能量谷把语音切成 ≤maxSec 的段（纯函数，导出便于单测）
 * ① 50ms 窗/25ms 步进能量；阈值 = 底噪(最低20%分位)×4，且不低于 1e-5（与 renderer/vad.js 同口径）
 * ② 相邻静音 ≥250ms 视为句间边界 → 语音岛；③ 边界外扩一窗（防切词头/尾）
 * ④ 相邻岛合并到 ≤maxSec（保持语句完整）；⑤ 仍超限的连续说话段在尾部 4s 内取能量最低窗切
 * @param {Float32Array} pcm 16k 单声道
 * @param {number} [sr] 采样率
 * @param {number} [maxSec] 单段上限（秒）
 * @returns {Array<{start: number, end: number}>} 段边界（样本下标）
 */
export function segmentVoice(pcm, sr = 16000, maxSec = SEG_MAX_SEC) {
  const total = pcm ? pcm.length : 0;
  if (!total || total < sr * 0.5) return [{ start: 0, end: total }];
  const win = Math.max(1, Math.floor(sr * 0.05));
  const step = Math.max(1, Math.floor(sr * 0.025));
  const wins = [];
  for (let i = 0; i + win <= total; i += step) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += pcm[j] * pcm[j];
    wins.push({ start: i, end: i + win, e: sum / win });
  }
  if (!wins.length) return [{ start: 0, end: total }];
  const sorted = wins.map((w) => w.e).sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)] || 0;
  const thr = Math.max(floor * 4, 1e-5);
  const voiced = wins.map((w) => w.e >= thr);

  // ①/② 语音岛（静音 ≥250ms 断开）
  const gapWins = Math.max(1, Math.round(0.25 / (step / sr)));
  const islands = [];
  let runStart = -1, silentRun = 0;
  for (let i = 0; i < wins.length; i++) {
    if (voiced[i]) { if (runStart < 0) runStart = i; silentRun = 0; continue; }
    if (runStart < 0) continue;
    silentRun++;
    if (silentRun >= gapWins) { islands.push([runStart, i - silentRun + 1]); runStart = -1; silentRun = 0; }
  }
  if (runStart >= 0) islands.push([runStart, wins.length - 1]);
  // 全程无静音（底噪≈语音电平，阈值判不出语音岛）→ 整段视作一个岛，
  // 交给 ⑤ 的"按 maxSec 在能量谷切"兜底（否则 40s 连续说话会整段送模型 → 跨句错配）
  if (!islands.length) islands.push([0, wins.length - 1]);

  // ③ 外扩一窗
  const segs = islands.map(([a, b]) => ({
    start: Math.max(0, wins[a].start - win),
    end: Math.min(total, wins[b].end + win),
  }));

  // ④ 合并相邻短段到 ≤maxSec
  const maxSamples = Math.floor(sr * maxSec);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.end - last.start <= maxSamples) last.end = s.end;
    else merged.push({ start: s.start, end: s.end });
  }

  // ⑤ 超限长段（连续说话无停顿）在尾部 4s 内取能量最低窗切
  const out = [];
  for (const s of merged) {
    let cur = s.start;
    while (s.end - cur > maxSamples) {
      const target = cur + maxSamples;
      let bestIdx = -1, bestE = Infinity;
      for (let i = 0; i < wins.length; i++) {
        const w = wins[i];
        if (w.end < target - sr * 4) continue;
        if (w.start > target) break;
        if (w.e < bestE) { bestE = w.e; bestIdx = i; }
      }
      const cut = bestIdx >= 0 ? Math.min(s.end, wins[bestIdx].end) : target;
      if (cut <= cur) break;
      out.push({ start: cur, end: cut });
      cur = cut;
    }
    if (s.end - cur > 0) out.push({ start: cur, end: s.end });
  }
  return out.filter((s) => s.end - s.start >= Math.floor(sr * 0.15)); // 丢弃过短残段
}

/** 单段识别（引擎分发；模型缺失/回退 whisper 语义与旧实现一致） */
async function transcribeOne(audio) {
  if (ENGINE === "sherpa") {
    try {
      return await transcribeSherpa(audio);
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes(MODEL_MISSING_HINT)) {
        return { ok: false, error: `本地语音模型未安装：请运行 node ${MODEL_MISSING_HINT} 下载后重试` };
      }
      // 模块加载阶段任何失败（包缺失/ABI 不兼容/构造异常）→ 统一回退 whisper，
      // 不再依赖错误消息匹配（消息内容随平台/版本变化，匹配不到会误报识别失败）
      if (e?.sherpaLoadFailed) {
        console.warn("[speech] sherpa 模块加载失败，回退 whisper:", msg);
        return await transcribeWhisper(audio);
      }
      return { ok: false, error: `识别失败: ${msg.slice(0, 120)}` };
    }
  }
  return transcribeWhisper(audio);
}

// ---------- 对外入口 ----------
/**
 * 语音转文本（16kHz mono Float32Array → 中文文本）
 * 长音频自动分段识别（见 segmentVoice 注释：整段送离线模型会跨句串位）
 * @param {Float32Array} audio PCM 采样
 * @returns {Promise<{ok: boolean, text?: string, error?: string, segments?: number}>}
 */
export async function transcribeAudio(audio) {
  if (!audio || !(audio instanceof Float32Array) || audio.length < 1600) {
    return { ok: false, error: "音频数据无效（过短或格式错误）" };
  }
  try {
    const segs = segmentVoice(audio, 16000, SEG_MAX_SEC);
    if (segs.length <= 1) {
      const r = await transcribeOne(audio);
      if (r.ok && r.text) r.text = fixTerms(r.text);
      return r;
    }
    const parts = [];
    for (const sg of segs) {
      const r = await transcribeOne(audio.subarray(sg.start, sg.end));
      if (r.ok && r.text) parts.push(r.text);
    }
    if (!parts.length) return { ok: false, error: "未识别到语音内容" };
    console.log(`[speech] 长音频分段识别：${segs.length} 段（${(audio.length / 16000).toFixed(1)}s）`);
    // 术语纠错：中文模型对英文术语识别差 → 归一为标准写法（React/Vue/Promise/Node.js…）
    return { ok: true, text: fixTerms(parts.join("，")), segments: segs.length };
  } catch (e) {
    console.error("[speech] 识别失败:", e?.message || e);
    return { ok: false, error: `识别失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

// ---------- 术语纠错（中文 ASR 对英文术语识别差的补偿） ----------
// paraformer-zh 是纯中文模型：英文技术词易被识别成小写/近似拼写/被拆成多个词
// （如 "web pack"、"node js"、"java script"）。这里做确定性后处理：
// 1) 先合并被拆的复合词（复合词必须优先于单词条，避免 "node" 先被单独消费）；
// 2) 再把已知技术术语的大小写变体归一为标准写法。
// 只匹配英文/数字 token，不碰中文，避免误伤普通文本。
/** @type {Array<[RegExp, string]>} 术语纠错表：[正则, 标准写法]（显式类型标注，防 tsc 推断成 string|RegExp 联合） */
const TERM_FIXES = [
  // —— 复合词（先匹配长词） ——
  [/\bjava\s*script\b|\bjavascript\b/gi, "JavaScript"],
  [/\btype\s*script\b|\btypescript\b/gi, "TypeScript"],
  [/\bnext\s*js\b|\bnextjs\b/gi, "Next.js"],
  [/\bnode\s*js\b|\bnodejs\b|\bnode\.js\b/gi, "Node.js"],
  [/\bweb\s*pack\b|\bwebpack\b/gi, "Webpack"],
  [/\basync\s*await\b/gi, "async/await"],
  [/\bci\s*cd\b|\bcicd\b/gi, "CI/CD"],
  [/\bpostgre\s*sql\b|\bpostgresql\b/gi, "PostgreSQL"],
  [/\bchrome\s*dev\s*tools\b/gi, "Chrome DevTools"],
  // —— 分段拼接产生的逗号断词（分段识别后段间补「，」，会把复合词切开） ——
  [/\bjava[，,]\s*script\b|\bjava\s*script\b/gi, "JavaScript"],
  [/\btype[，,]\s*script\b|\btypscript\b|\btypescript\b/gi, "TypeScript"],
  [/\bnode[，,\s]*js\b|\bnodejs\b|\bnode\.js\b|\bno[，,]\s*js\b/gi, "Node.js"],
  [/\bweb[，,]\s*pack\b|\bwebpack\b/gi, "Webpack"],
  [/async[，,]\s*await/gi, "async/await"],
  [/ci[，,]\s*cd\b|\bcicd\b/gi, "CI/CD"],
  [/chrome[，,]\s*dev[，,]\s*tools/gi, "Chrome DevTools"],
  // —— 中文同音词（实测：真实面试转写的常见别字，多字上下文锚定防误伤） ——
  [/技术战[士是]|技术站[士是]|技术占[士是]/g, "技术栈是"],
  [/有线状态机|有限装态机/g, "有限状态机"],
  [/六台(?=(?:的)?(?:有限)?状态机)/g, "六态"],
  [/(?:修改|修理|整理)(?:模拟|模析|模晰)/g, "简历解析"],
  // —— 单词条 ——
  [/\bpromise\b/gi, "Promise"],
  [/\breact\b/gi, "React"],
  [/\bvue\b/gi, "Vue"],
  [/\bangular\b/gi, "Angular"],
  [/\bfiber\b/gi, "Fiber"],
  [/\bredux\b/gi, "Redux"],
  [/\bpinia\b/gi, "Pinia"],
  [/\bvite\b/gi, "Vite"],
  [/\bapi\b/gi, "API"],
  [/\bjson\b/gi, "JSON"],
  [/\bhtml\b/gi, "HTML"],
  [/\bcss\b/gi, "CSS"],
  [/\bxml\b/gi, "XML"],
  [/\bhttp\b/gi, "HTTP"],
  [/\bhttps\b/gi, "HTTPS"],
  [/\btcp\b/gi, "TCP"],
  [/\budp\b/gi, "UDP"],
  [/\bdns\b/gi, "DNS"],
  [/\bdom\b/gi, "DOM"],
  [/\bwebsocket\b/gi, "WebSocket"],
  [/\bcors\b/gi, "CORS"],
  [/\bcdn\b/gi, "CDN"],
  [/\burl\b/gi, "URL"],
  [/\bui\b/gi, "UI"],
  [/\bux\b/gi, "UX"],
  [/\bgit\b/gi, "Git"],
  [/\bdocker\b/gi, "Docker"],
  [/\bkubernetes\b|\bk8s\b/gi, "Kubernetes"],
  [/\blinux\b/gi, "Linux"],
  [/\bredis\b/gi, "Redis"],
  [/\bmysql\b/gi, "MySQL"],
  [/\bmongodb\b/gi, "MongoDB"],
  [/\bsql\b/gi, "SQL"],
  [/\bdfs\b/gi, "DFS"],
  [/\bbfs\b/gi, "BFS"],
  [/\bdp\b/gi, "DP"],
  [/\blru\b/gi, "LRU"],
  [/\blfu\b/gi, "LFU"],
  [/\bchrome\b/gi, "Chrome"],
  [/\bsafari\b/gi, "Safari"],
  [/\bjest\b/gi, "Jest"],
  [/\bplaywright\b/gi, "Playwright"],
  [/\bssr\b/gi, "SSR"],
  [/\bcsp\b/gi, "CSP"],
  [/\bajax\b/gi, "Ajax"],
  [/\bgraphql\b/gi, "GraphQL"],
  [/\bes6\b/gi, "ES6"],
  [/\besnext\b/gi, "ESNext"],
  // —— 实测新增（真实面试转写观测到的写法） ——
  [/\bvu\b/gi, "Vue"],
  [/\bjd\b/gi, "JD"],
  [/\bfsm\b/gi, "FSM"],
  [/\btransit\b/gi, "transition"],
];

/** 术语归一（导出便于单测）：识别文本 → 标准术语写法 */
export function fixTerms(text) {
  let t = String(text || "");
  for (const [re, std] of TERM_FIXES) t = t.replace(re, std);
  return t;
}

/** 当前引擎名（面板提示用） */
export function getSpeechEngine() {
  return ENGINE;
}
