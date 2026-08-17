// 长句音频后处理：loudnorm 归一化 + 保守静音压缩（阈值 -50dB，只清真正的大段静音）
// 用法：node scripts/_postprocess-voices.mjs
import { execSync } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const FFMPEG = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffprobe.exe";
const DIR = "assets/voice/long";

const dur = (f) => Number(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${f}"`, { encoding: "utf8" }).trim());

const files = readdirSync(DIR).filter((f) => f.endsWith(".wav") && /-long-\d/.test(f));
console.log(`后处理 ${files.length} 个长句`);
for (const f of files) {
  const p = path.join(DIR, f);
  const tmp = path.join(DIR, ".pp-tmp.wav");
  const before = dur(p);
  try {
    // 1) loudnorm 归一化（-16 LUFS 语音标准；也保证后续静音检测阈值可靠）
    // 2) 静音压缩：只处理 >=1.0s 且 < -50dB 的真静音段（保留 0.35s），
    //    阈值保守——GPT-SoVITS 输出低音量语音不会被误删（教训：-35dB 删掉了大半内容）
    const filter = "loudnorm=I=-16:TP=-1.5:LRA=11,silenceremove=start_periods=1:start_duration=0.5:start_threshold=-50dB:stop_periods=-1:stop_duration=1.0:stop_threshold=-50dB:stop_silence=0.35";
    execSync(`"${FFMPEG}" -y -v error -i "${p}" -af "${filter}" "${tmp}"`, { stdio: "pipe" });
    if (!existsSync(tmp) || statSync(tmp).size < 10000) throw new Error("输出异常");
    execSync(`move /y "${tmp}" "${p}"`, { stdio: "ignore" });
    const after = dur(p);
    console.log(`✅ ${f}: ${before.toFixed(1)}s → ${after.toFixed(1)}s`);
  } catch (e) {
    console.log(`❌ ${f}: ${String(e.message).slice(0, 120)}`);
    try { execSync(`del /q "${tmp}"`, { stdio: "ignore" }); } catch { /* ignore */ }
  }
}
