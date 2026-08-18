// lib/speech-worker.mjs —— 语音识别 worker 线程（解主进程卡顿）
// 背景：@xenova/transformers 的 whisper WASM 推理是同步计算，跑在 Electron 主进程
// 会阻塞整个桌宠（窗口/拖拽/所有 IPC 冻结，一条语音卡几十秒）。
// 方案：ASR 常驻 worker 线程——模型只加载一次，推理不碰主进程事件循环。
// main.mjs 的 speech:transcribe 向本 worker 发 {id, audio} 并等待回传。
import { parentPort } from "node:worker_threads";
import { transcribeAudio } from "./speech.mjs";

parentPort.on("message", async (msg) => {
  try {
    const audio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || []);
    const r = await transcribeAudio(audio);
    parentPort.postMessage({ id: msg.id, ok: r.ok, text: r.text || "", error: r.error || "" });
  } catch (e) {
    parentPort.postMessage({ id: msg.id, ok: false, text: "", error: String(e?.message || e).slice(0, 120) });
  }
});
