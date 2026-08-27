// 实时 TTS 服务客户端（GPT-SoVITS 本地，bin/tts-server.mjs）
// synthesize：预设/缓存未命中时调用；失败/超时由上层降级（预设 ack / 静音）
const TOKEN = process.env.MIANSHI_TTS_TOKEN || "";
const DEFAULT_TIMEOUT_MS = 15000;

/** 动态读 base（测试可切换；模块加载期不固化） */
function base() {
  return process.env.MIANSHI_TTS_URL || "http://127.0.0.1:8900";
}

function headers() {
  const h = { "Content-Type": "application/json" };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

/** 合成一句（≤60 字）。成功返回 {ok:true, wav:base64, sr, ms, queueLen}；失败/未就绪/超时返回 {ok:false, error, status?}
 * @param {string} text
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
 */
export async function synthesize(text, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const clean = String(text || "").trim().slice(0, 60);
  if (!clean) return { ok: false, error: "empty text" };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onAbort);
    try {
      const res = await fetch(`${base()}/api/tts/synthesize`, {
        method: "POST", headers: headers(), body: JSON.stringify({ text: clean }), signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 503) return { ok: false, error: "tts not ready", status: 503 };
      if (res.status === 504) return { ok: false, error: "synthesize timeout", status: 504 };
      if (!res.ok) return { ok: false, error: data.error || `http ${res.status}`, status: res.status };
      return data.ok ? { ok: true, wav: data.wav, sr: data.sr, ms: data.ms, queueLen: data.queueLen ?? 0 } : { ok: false, error: data.error || "synthesize failed" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch (e) {
    return { ok: false, error: String(e?.message || e).slice(0, 120) };
  }
}

/** 服务状态（模型是否加载完成、队列长度） */
export async function status({ timeoutMs = 5000 } = {}) {
  try {
    const res = await fetch(`${base()}/api/tts/status`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
    return await res.json();
  } catch {
    return { loaded: false, queueLen: 0, error: "tts server unreachable" };
  }
}

/** 清空排队请求（不等在途合成） */
export async function abort() {
  try {
    await fetch(`${base()}/api/tts/abort`, { method: "POST", headers: headers(), signal: AbortSignal.timeout(3000) });
  } catch { /* 忽略 */ }
}

