// scripts/_asr-smoke.mjs —— 临时冒烟：edge-tts 合成中文 → 16k → worker ASR 转写
// 验证真实链路（模型加载/推理/文本返回）+ 记录耗时（模型加载 vs 推理）
import { Worker } from "node:worker_threads";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFMPEG = "D:/hfut/file/Videopro/exp01/exp01_ffmpeg/ffmpeg/ffmpeg/bin/ffmpeg.exe";
const TMP = path.join(ROOT, "scripts", "_asr-smoke");

async function main() {
  mkdirSync(TMP, { recursive: true });
  const text = process.argv[2] || "今天天气真不错，我们一起来准备前端秋招面试吧，先看一道数组去重的题目。";

  // 1) TTS 合成（微软 edge 神经语音，中文女声）——toFile 自动追加扩展名
  const { EdgeTTS } = await import("@andresaya/edge-tts");
  const tts = new EdgeTTS();
  await tts.synthesize(text, "zh-CN-XiaoxiaoNeural");
  const mp3Path = await tts.toFile(path.join(TMP, "in"));
  console.log("合成:", path.basename(mp3Path));

  // 2) ffmpeg → 16k 单声道 f32le（等价 renderer 录音后的 PCM）
  execFileSync(FFMPEG, ["-y", "-i", mp3Path, "-ar", "16000", "-ac", "1", "-f", "f32le", path.join(TMP, "in.f32")], { stdio: "ignore" });
  const raw = readFileSync(path.join(TMP, "in.f32"));
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  console.log(`音频 ${(pcm.length / 16000).toFixed(2)}s（${text.slice(0, 30)}…）`);

  // 3) 真实链路：worker 加载模型 + 推理（与桌宠 main.mjs 相同路径）
  //    不 transfer：脚本内还要复用 pcm 测第二轮；7s 音频拷贝开销可忽略
  const worker = new Worker(path.join(ROOT, "lib", "speech-worker.mjs"));
  const t0 = Date.now();
  const result = await new Promise((resolve, reject) => {
    worker.on("message", resolve);
    worker.on("error", (e) => reject(new Error("worker error: " + (e?.message || e))));
    worker.on("exit", (c) => reject(new Error("worker exit " + c)));
    worker.postMessage({ id: 1, audio: pcm });
  });
  console.log(`首轮耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（含模型加载）`);
  console.log("首轮转写:", JSON.stringify(result, null, 2));

  // 4) 第二轮（模型已缓存）单独测推理耗时
  const t1 = Date.now();
  const result2 = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", (e) => reject(new Error("worker error: " + (e?.message || e))));
    worker.postMessage({ id: 2, audio: pcm });
  });
  console.log(`推理耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s（模型已加载）`);
  console.log("转写:", JSON.stringify(result2, null, 2));
  await worker.terminate();
  rmSync(TMP, { recursive: true, force: true });
}

main().catch((e) => { console.error("冒烟失败:", e); process.exit(1); });
