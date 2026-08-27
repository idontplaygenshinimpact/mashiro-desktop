// 实时语音模拟播放：切句 → 队列（prepare 合成 / play 播放 + 预取）→ 真实 TTS 服务 + ffplay
// 用法：node scripts/_tts-play-sim.mjs（需 tts-server 已就绪）
import { createSpeechQueue, splitSentences } from "../desktop/renderer/speech-queue.mjs";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FFPLAY = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffplay.exe";

const playWav = (p) => new Promise((resolve) => {
  const c = execFile(FFPLAY, ["-nodisp", "-autoexit", "-volume", "80", p], /** @type {import("node:child_process").ExecFileOptions} */ ({ stdio: "ignore" }), () => resolve());
  c.on("error", () => resolve());
});

const synth = async (text) => {
  try {
    const r = await fetch("http://127.0.0.1:8900/api/tts/synthesize", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }), signal: AbortSignal.timeout(20000),
    });
    const d = await r.json();
    if (!d.ok) return null;
    const f = path.join(os.tmpdir(), `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.wav`);
    writeFileSync(f, Buffer.from(d.wav, "base64"));
    return f;
  } catch { return null; }
};

// 模拟一段 LLM 流式回复（多句，测试句间连贯性）
const reply = "面接、お疲れさま。よく頑張ったね。今日のあなたは、とても輝いて見えたよ。お茶でも入れて、少し休もうか。";
const { sentences } = splitSentences(reply);
console.log("切句:", sentences.map((s) => s.slice(0, 12)).join(" | "));

const t0 = Date.now();
const q = createSpeechQueue({
  prepare: async (t) => { const f = await synth(t); console.log(`  [synth] ${t.slice(0, 10)}... ${f ? "ok" : "FAIL"}`); return f; },
  play: async (p) => { if (p) { await playWav(p); try { const { unlinkSync } = await import("node:fs"); unlinkSync(p); } catch {} } },
});
for (const s of sentences) q.push(s);

await new Promise((resolve) => {
  const iv = setInterval(() => { if (!q.isSpeaking && q.size === 0) { clearInterval(iv); resolve(); } }, 50);
});
console.log(`总耗时 ${Date.now() - t0}ms / ${sentences.length} 句（含首句预热+合成+播放）`);

