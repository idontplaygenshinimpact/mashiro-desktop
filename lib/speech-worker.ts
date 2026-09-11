// lib/speech-worker.ts —— 语音识别 worker 线程（解主进程卡顿）
// 背景：@xenova/transformers 的 whisper WASM 推理是同步计算，跑在 Electron 主进程
// 会阻塞整个桌宠（窗口/拖拽/所有 IPC 冻结，一条语音卡几十秒）。
// 方案：ASR 常驻 worker 线程——模型只加载一次，推理不碰主进程事件循环。
// main.mjs 的 speech:transcribe 向本 worker 发 {id, audio} 并等待回传。
// 全量 TS 升级工单阶段 3：lib/speech-worker.mjs → .ts（worker 入口由 Electron 主进程 new Worker(path) 加载；
//   Electron 内置 Node 已支持类型擦除——main.mjs 已动态 import 多个 .ts 模块为证 → 路径同步改为 .ts）
import { parentPort } from "node:worker_threads";
import { transcribeAudio } from "./speech.mjs";

/** 主进程发来的转写请求（audio 为 16k Float32 PCM） */
interface SpeechRequest {
  id: number | string;
  audio: Float32Array | number[];
}

/** 回传结果（保持 id 契约） */
interface SpeechResponse {
  id: number | string;
  ok: boolean;
  text: string;
  error: string;
}

// 串行化：ASR 推理是同步计算，并发消息会互相阻塞/交错 → promise 链逐个处理（保持 id 回传契约）
let chain: Promise<unknown> = Promise.resolve();

async function handle(msg: SpeechRequest): Promise<void> {
  try {
    const audio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || []);
    console.log(`[speech-worker] 收到 ${audio.length} 采样，开始转写…`);
    const r = await transcribeAudio(audio);
    console.log(`[speech-worker] 完成: ok=${r.ok} text=${(r.text || "").slice(0, 40)} err=${r.error || ""}`);
    const res: SpeechResponse = { id: msg.id, ok: Boolean(r.ok), text: r.text || "", error: r.error || "" };
    parentPort!.postMessage(res);
  } catch (e) {
    const err = e as Error;
    console.error("[speech-worker] 异常:", err?.message || err);
    const res: SpeechResponse = { id: msg.id, ok: false, text: "", error: String(err?.message || err).slice(0, 120) };
    parentPort!.postMessage(res);
  }
}

parentPort!.on("message", (msg: SpeechRequest) => {
  chain = chain.then(() => handle(msg)).catch(() => {});
});
