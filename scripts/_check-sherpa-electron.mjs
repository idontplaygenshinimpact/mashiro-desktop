// scripts/_check-sherpa-electron.mjs —— 验证 sherpa-onnx-node 原生 addon 在 Electron 主进程可加载
// 用法: npx electron scripts/_check-sherpa-electron.mjs
// 桌宠真实运行环境是 Electron（非纯 Node），N-API addon 必须在此 ABI 下可加载
import { app } from "electron";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

app.whenReady().then(() => {
  try {
    const sherpa = require("sherpa-onnx-node");
    const rec = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        paraformer: { model: path.join(ROOT, "models", "sherpa-onnx-paraformer-zh", "model.int8.onnx") },
        tokens: path.join(ROOT, "models", "sherpa-onnx-paraformer-zh", "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    });
    // 1s 静音音频解码不崩即可（识别链路在 Electron 内可用）
    const stream = rec.createStream();
    stream.acceptWaveform({ samples: new Float32Array(16000), sampleRate: 16000 });
    rec.decode(stream);
    const text = rec.getResult(stream).text || "";
    console.log(`OK: sherpa-onnx-node ${require("sherpa-onnx-node/package.json").version} loaded in Electron ${process.versions.electron}, result="${text}"`);
    app.exit(0);
  } catch (e) {
    console.error("FAIL:", e?.message || e);
    app.exit(1);
  }
});
