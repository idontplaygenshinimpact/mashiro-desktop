// scripts/_check-sherpa-electron-worker.mjs —— 验证 Electron 主进程内 worker_threads 加载 sherpa addon
// 用法: npx electron scripts/_check-sherpa-electron-worker.mjs
// 背景：语音 ASR 推理在 worker 线程（lib/speech-worker.mjs）——但从未验证过
//       Electron 的 worker 环境能否加载 sherpa-onnx-node 原生 addon（若挂起 = 语音卡死根因）
import { app } from "electron";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = path.join(ROOT, "models", "sherpa-onnx-paraformer-zh", "model.int8.onnx");
const TOKENS = path.join(ROOT, "models", "sherpa-onnx-paraformer-zh", "tokens.txt");

app.whenReady().then(() => {
  const worker = new Worker(path.join(ROOT, "scripts", "_worker-asr-probe.mjs"), {
    workerData: { model: MODEL, tokens: TOKENS },
  });
  const timer = setTimeout(() => {
    console.error("FAIL: worker 15s 未响应（Electron worker 加载 sherpa addon 挂起）");
    worker.terminate();
    app.exit(1);
  }, 15000);
  worker.on("message", (m) => {
    clearTimeout(timer);
    if (m.ok) console.log(`OK: Electron worker 内加载 sherpa 成功, result="${m.text}"`);
    else console.error("FAIL:", m.error);
    app.exit(m.ok ? 0 : 1);
  });
  worker.on("error", (e) => { clearTimeout(timer); console.error("FAIL worker error:", e?.message || e); app.exit(1); });
});
