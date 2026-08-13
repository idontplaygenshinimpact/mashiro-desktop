// 语音输入识别（本地离线 whisper，零 API key）
// 复用 @xenova/transformers（与 RAG bge-m3 同一栈）：主进程 WASM 推理，不卡 UI
// 模型：Xenova/whisper-small（量化版，中文可用），首次使用自动从 hf-mirror 下载（~250MB）
// 输入：16kHz 单声道 Float32Array（renderer 负责录制重采样）

const ASR_MODEL = process.env.SPEECH_ASR_MODEL || "Xenova/whisper-small";

let asrPromise = null; // pipeline 单例（懒加载 + 缓存）

/** 加载/缓存 whisper 管线；加载失败时重置缓存，下次调用可重试（避免永久失效） */
function getASR() {
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
    const asr = await getASR();
    // whisper 内部按 16k 处理；强制中文 + transcribe 减少幻觉
    const out = await asr(audio, { language: "chinese", task: "transcribe" });
    const text = (out?.text || "").trim();
    if (!text) return { ok: false, error: "未识别到语音内容" };
    return { ok: true, text };
  } catch (e) {
    console.error("[speech] 识别失败:", e?.message || e);
    return { ok: false, error: `识别失败: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/** 模型加载状态（面板提示首次下载用） */
export function isASRLoading() {
  return asrPromise !== null;
}
