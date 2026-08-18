// scripts/_worker-asr-probe.mjs —— 被 Electron 主进程 fork 的 worker：加载 sherpa 并识别一段静音
import { parentPort, workerData } from "node:worker_threads";

try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const sherpa = require("sherpa-onnx-node");
  const rec = new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      paraformer: { model: workerData.model },
      tokens: workerData.tokens,
      numThreads: 2,
      provider: "cpu",
      debug: 0,
    },
  });
  const stream = rec.createStream();
  stream.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 });
  rec.decode(stream);
  const text = rec.getResult(stream).text || "";
  parentPort.postMessage({ ok: true, text, thread: "worker" });
} catch (e) {
  parentPort.postMessage({ ok: false, error: String(e?.message || e).slice(0, 200) });
}
