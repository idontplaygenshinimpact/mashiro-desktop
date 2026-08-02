// edge-tts 神经语音：真白语音（晓伊少女音）
// 生成 mp3 → 用 Windows MediaPlayer 播放（替代机械的 System.Speech）
import { EdgeTTS } from "@andresaya/edge-tts";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// 晓伊：活泼少女音，最贴真白人设；备选：晓晓（标准女声）、云希（少年）
const VOICE = process.env.MIASHI_TTS_VOICE || "zh-CN-XiaoyiNeural";
const TMP_DIR = path.join(os.tmpdir(), "mashiro-tts");

// 生成 mp3 并播放（异步，不阻塞）
export async function speak(text) {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { ok: false, error: "empty" };
  try {
    mkdirSync(TMP_DIR, { recursive: true });
    const mp3 = path.join(TMP_DIR, `speak-${Date.now()}.mp3`);
    const tts = new EdgeTTS();
    await tts.synthesize(clean, VOICE, { rate: "+10%", pitch: "+5Hz", volume: "+0%" });
    await tts.toFile(mp3, "mp3");
    // 用 Windows MediaPlayer 播放 mp3（支持 mp3，比 SoundPlayer 好）
    playMp3(mp3);
    return { ok: true, mp3 };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Windows MediaPlayer 播放（WPF 组件，支持 mp3/网络流）
function playMp3(mp3) {
  const ps = `
Add-Type -AssemblyName PresentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([System.Uri]::new('${mp3.replace(/'/g, "''")}'))
$p.Play()
Start-Sleep -Milliseconds 300
while ($p.NaturalDuration.HasTimeSpan -and ($p.Position -lt $p.NaturalDuration.TimeSpan)) { Start-Sleep -Milliseconds 200 }
$p.Close()`;
  const psFile = path.join(TMP_DIR, "play.ps1");
  writeFileSync(psFile, ps, "utf8");
  try {
    spawn("pwsh", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch {
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psFile], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  }
}
