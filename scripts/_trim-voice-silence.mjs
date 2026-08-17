// 压缩长句音频的异常静音（split-merge 合成残留）：>0.8s 静音压到 0.4s，削开头/尾部静音
// 用法：node scripts/_trim-voice-silence.mjs
import { execSync } from "node:child_process";
import { readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";

const FFMPEG = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffmpeg.exe";
const FFPROBE = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffprobe.exe";
const DIR = "assets/voice/long";
const FILTER = "silenceremove=start_periods=1:start_duration=0.5:start_threshold=-35dB:stop_periods=-1:stop_duration=0.8:stop_threshold=-35dB:stop_silence=0.4";

const dur = (f) => Number(execSync(`"${FFPROBE}" -v error -show_entries format=duration -of csv=p=0 "${f}"`, { encoding: "utf8" }).trim());

const files = readdirSync(DIR).filter((f) => f.endsWith(".wav") && /-long-\d/.test(f));
console.log(`处理 ${files.length} 个长句文件`);
for (const f of files) {
  const p = path.join(DIR, f);
  const tmp = path.join(DIR, ".trim-tmp.wav");
  const before = dur(p);
  try {
    execSync(`"${FFMPEG}" -y -v error -i "${p}" -af "${FILTER}" "${tmp}"`, { stdio: "pipe" });
    if (!existsSync(tmp) || statSync(tmp).size < 10000) throw new Error("输出异常");
    execSync(`move /y "${tmp}" "${p}"`, { stdio: "ignore" });
    const after = dur(p);
    console.log(`✅ ${f}: ${before.toFixed(1)}s → ${after.toFixed(1)}s（压掉 ${(before - after).toFixed(1)}s 静音）`);
  } catch (e) {
    console.log(`❌ ${f}: ${String(e.message).slice(0, 100)}`);
    try { execSync(`del /q "${tmp}"`, { stdio: "ignore" }); } catch { /* ignore */ }
  }
}
