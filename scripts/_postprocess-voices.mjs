// 长句音频后处理 v2：loudnorm 归一化 + 保守静音压缩 + 尾部淡出（修复结尾突兀）
// 结尾突兀原因：silenceremove 硬切语音尾部自然衰减 → 声音戛然而止。
// 修复：压缩后按实际时长加 afade 0.6s 淡出 + 补 0.25s 尾静音，结尾自然收束。
// 用法：node scripts/_postprocess-voices.mjs
import { execSync } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const FFMPEG = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffprobe.exe";
const DIR = "assets/voice/long";

const dur = (f) => Number(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${f}"`, { encoding: "utf8" }).trim());

const files = readdirSync(DIR).filter((f) => f.endsWith(".wav") && /-long-\d/.test(f));
console.log(`后处理 ${files.length} 个长句（v2 带尾部淡出）`);
for (const f of files) {
  const p = path.join(DIR, f);
  const tmp1 = path.join(DIR, ".pp1.wav");
  const tmp2 = path.join(DIR, ".pp2.wav");
  const before = dur(p);
  try {
    // 1) loudnorm 归一化 + 保守静音压缩（-50dB 只清真静音；教训：-35dB 误删低音量语音）
    const f1 = "loudnorm=I=-16:TP=-1.5:LRA=11,silenceremove=start_periods=1:start_duration=0.5:start_threshold=-50dB:stop_periods=-1:stop_duration=1.0:stop_threshold=-50dB:stop_silence=0.35";
    execSync(`"${FFMPEG}" -y -v error -i "${p}" -af "${f1}" "${tmp1}"`, { stdio: "pipe" });
    if (!existsSync(tmp1) || statSync(tmp1).size < 10000) throw new Error("第一步输出异常");
    // 2) 按实际时长尾部淡出 0.6s + 补尾静音（结尾自然收束，不突兀）
    // 注意：旧版 ffmpeg apad 只有 pad_len（采样数），无 pad_dur；32k 采样率下 0.25s ≈ 8000 采样
    const d1 = dur(tmp1);
    const fadeStart = Math.max(0, d1 - 0.6);
    const f2 = `afade=t=out:st=${fadeStart.toFixed(2)}:d=0.6,apad=pad_len=8000`;
    execSync(`"${FFMPEG}" -y -v error -i "${tmp1}" -af "${f2}" "${tmp2}"`, { stdio: "pipe" });
    if (!existsSync(tmp2) || statSync(tmp2).size < 10000) throw new Error("第二步输出异常");
    execSync(`move /y "${tmp2}" "${p}"`, { stdio: "ignore" });
    const after = dur(p);
    console.log(`✅ ${f}: ${before.toFixed(1)}s → ${after.toFixed(1)}s（尾部淡出 0.6s + 尾静音 0.25s）`);
  } catch (e) {
    console.log(`❌ ${f}: ${String(e.message).slice(0, 120)}`);
  } finally {
    for (const t of [tmp1, tmp2]) { try { execSync(`del /q "${t}"`, { stdio: "ignore" }); } catch { /* ignore */ } }
  }
}
