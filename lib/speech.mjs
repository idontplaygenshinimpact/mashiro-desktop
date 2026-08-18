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
      throw e;
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
    if (ENGINE === "sherpa") {
      try {
        return await transcribeSherpa(audio);
      } catch (e) {
        const msg = String(e?.message || e);
        if (msg.includes(MODEL_MISSING_HINT)) {
          return { ok: false, error: `本地语音模型未安装：请运行 node ${MODEL_MISSING_HINT} 下载后重试` };
        }
        if (msg.includes("sherpa-onnx-node") || msg.includes("Cannot find module")) {
          console.warn("[speech] sherpa-onnx-node 不可用，回退 whisper:", msg);
          return await transcribeWhisper(audio);
        }
        return { ok: false, error: `识别失败: ${msg.slice(0, 120)}` };
      }
    }
    return await transcribeWhisper(audio);
  } catch (e) {
    console.error("[speech] 识别失败:", e?.message || e);
    return { ok: false, error: `识别失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 当前引擎名（面板提示用） */
export function getSpeechEngine() {
  return ENGINE;
}
