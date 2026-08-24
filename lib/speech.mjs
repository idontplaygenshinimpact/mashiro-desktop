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

// ---------- 对外入口 ----------
/**
 * 语音转文本（16kHz mono Float32Array → 中文文本）
 * @param {Float32Array} audio PCM 采样
 * @returns {Promise<{ok: boolean, text?: string, error?: string}>}
 */
export async function transcribeAudio(audio) {
  if (!audio || !(audio instanceof Float32Array) || audio.length < 1600) {
    return { ok: false, error: "音频数据无效（过短或格式错误）" };
  }
  try {
    let r;
    if (ENGINE === "sherpa") {
      try {
        r = await transcribeSherpa(audio);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes(MODEL_MISSING_HINT)) {
          return { ok: false, error: `本地语音模型未安装：请运行 node ${MODEL_MISSING_HINT} 下载后重试` };
        }
        // 模块加载阶段任何失败（包缺失/ABI 不兼容/构造异常）→ 统一回退 whisper，
        // 不再依赖错误消息匹配（消息内容随平台/版本变化，匹配不到会误报识别失败）
        if (e?.sherpaLoadFailed) {
          console.warn("[speech] sherpa 模块加载失败，回退 whisper:", msg);
          r = await transcribeWhisper(audio);
        } else {
          return { ok: false, error: `识别失败: ${msg.slice(0, 120)}` };
        }
      }
    } else {
      r = await transcribeWhisper(audio);
    }
    // 术语纠错：中文模型对英文术语识别差 → 归一为标准写法（React/Vue/Promise/Node.js…）
    if (r.ok && r.text) r.text = fixTerms(r.text);
    return r;
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
