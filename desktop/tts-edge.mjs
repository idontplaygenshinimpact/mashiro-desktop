// 真白语音（神经 TTS）：
//   日语 → VoiceVox（本地开源动漫系日语神经 TTS，四国めたん あまあま）
//   中文 → edge-tts 晓伊（微软神经语音）
// VoiceVox 不可用/失败 → 自动降级 edge-tts Nanami（日语）
import { EdgeTTS } from "@andresaya/edge-tts";
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------- 配置 ----------
const VOICE_ZH = process.env.MIASHI_TTS_VOICE || "zh-CN-XiaoyiNeural";
const VOICE_JA_FALLBACK = process.env.MIASHI_TTS_VOICE_JA || "ja-JP-NanamiNeural";
// VoiceVox 角色：0=四国めたん(あまあま 甜系) 2=四国めたん(normal) 3=ずんだもん(normal)
const VV_URL = process.env.VOICEVOX_URL || "http://127.0.0.1:50021";
const VV_SPEAKER = Number(process.env.VOICEVOX_SPEAKER || 0);
// 引擎安装目录（Windows CPU 版，run.exe 在 vv-engine 子目录）
const VV_DIR = process.env.VOICEVOX_DIR || "D:\\VOICEVOX\\VOICEVOX\\vv-engine";
const TMP_DIR = path.join(os.tmpdir(), "mashiro-tts");

let vvStarted = false; // 已尝试启动引擎（避免重复 spawn）
let vvProc = null;     // 引擎进程句柄（用于空闲回收）
let vvLastUsed = 0;    // 最后一次语音合成时间
let reapTimer = null;
const VV_IDLE_MS = Number(process.env.VOICEVOX_IDLE_MS || 30 * 60 * 1000); // 空闲 30 分钟回收

// ---------- VoiceVox 引擎管理（懒启动 + 空闲回收，平时零占用） ----------
async function voicevoxReady(timeoutMs = 90000) {
  const probe = async () => {
    try {
      const r = await fetch(`${VV_URL}/speakers`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch { return false; }
  };
  if (await probe()) return true;
  if (vvStarted) return false; // 已启动过仍不可用 → 放弃本次
  // 懒启动引擎（run.exe headless）
  vvStarted = true;
  for (const exe of ["run.exe", "VOICEVOX.exe"]) {
    const p = path.join(VV_DIR, exe);
    if (!existsSync(p)) continue;
    try {
      vvProc = spawn(p, ["--port", "50021", "--cpu_num_threads", "2"], {
        cwd: VV_DIR, windowsHide: true, detached: true, stdio: "ignore",
      });
      vvProc.unref();
      // 低优先级：不抢桌宠/其他应用 CPU
      try {
        const { execFileSync } = await import("node:child_process");
        execFileSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${vvProc.pid} -ErrorAction SilentlyContinue).PriorityClass = 'BelowNormal'`], { windowsHide: true, timeout: 8000, stdio: "ignore" });
      } catch { /* ignore */ }
      break;
    } catch { vvProc = null; /* ignore */ }
  }
  // 轮询就绪
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (await probe()) { vvLastUsed = Date.now(); return true; }
  }
  return false;
}

/** 空闲回收：一段时间无请求就退出引擎释放内存 */
function scheduleIdleReap() {
  clearTimeout(reapTimer);
  reapTimer = setTimeout(() => {
    if (vvProc && Date.now() - vvLastUsed > VV_IDLE_MS) {
      try { vvProc.kill(); } catch { /* ignore */ }
      vvProc = null;
      vvStarted = false; // 允许下次重新拉起
      console.log("[tts] VoiceVox 空闲回收，已释放内存");
    }
  }, VV_IDLE_MS);
}

/** VoiceVox 合成日语 wav 并播放 */
async function voicevoxSpeak(text) {
  vvLastUsed = Date.now();
  scheduleIdleReap();
  const queryRes = await fetch(`${VV_URL}/audio_query?speaker=${VV_SPEAKER}&text=${encodeURIComponent(text)}`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
  });
  if (!queryRes.ok) throw new Error(`audio_query ${queryRes.status}`);
  const query = await queryRes.json();
  const wavRes = await fetch(`${VV_URL}/synthesis?speaker=${VV_SPEAKER}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query),
    signal: AbortSignal.timeout(60000),
  });
  if (!wavRes.ok) throw new Error(`synthesis ${wavRes.status}`);
  const buf = Buffer.from(await wavRes.arrayBuffer());
  if (buf.length < 1024) throw new Error("synthesis 输出过短");
  mkdirSync(TMP_DIR, { recursive: true });
  const wavFile = path.join(TMP_DIR, `vv-${Date.now()}.wav`);
  writeFileSync(wavFile, buf);
  playWav(wavFile);
  return { ok: true, engine: "voicevox", file: wavFile };
}

// ---------- edge-tts 兜底 ----------
function pickVoice(text) {
  return /[\u3040-\u30ff]/.test(text) ? VOICE_JA_FALLBACK : VOICE_ZH;
}

async function edgeTtsSpeak(text) {
  const isJa = pickVoice(text) === VOICE_JA_FALLBACK;
  const opts = isJa ? { rate: "+0%", pitch: "+0Hz", volume: "+0%" } : { rate: "+10%", pitch: "+5Hz", volume: "+0%" };
  const mp3Base = path.join(TMP_DIR, `speak-${Date.now()}`);
  const tts = new EdgeTTS();
  await tts.synthesize(text, pickVoice(text), opts);
  await tts.toFile(mp3Base, "mp3"); // → .mp3（库自动加扩展名）
  playMp3(mp3Base + ".mp3");
  return { ok: true, engine: "edge-tts", voice: pickVoice(text), mp3: mp3Base + ".mp3" };
}

// ---------- 入口 ----------
export async function speak(text) {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { ok: false, error: "empty" };
  // 固定语音包优先：预设台词（真白日语角色音）→ 零延迟直接播文件
  try {
    const { matchVoicePack, playVoicePack } = await import("./voice-pack.mjs");
    const hit = matchVoicePack(clean);
    if (hit) {
      console.log(`[tts] 语音包命中（${hit.scene}）→ ${hit.file}`);
      return playVoicePack(hit.file);
    }
  } catch { /* 语音包不可用 → 实时 TTS */ }
  // 日语 → VoiceVox 优先（动漫声）；失败降级 edge-tts
  if (/[\u3040-\u30ff]/.test(clean)) {
    try {
      if (await voicevoxReady()) return await voicevoxSpeak(clean);
      console.log("[tts] VoiceVox 不可用，降级 edge-tts");
    } catch (e) {
      console.log(`[tts] VoiceVox 失败(${e.message.slice(0, 60)})，降级 edge-tts`);
    }
  }
  try {
    return await edgeTtsSpeak(clean);
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 播放（ffplay 直接播，最可靠；mp3 同样走 ffplay） ----------
const FFPLAY = "D:\\hfut\\file\\Videopro\\exp01\\exp01_ffmpeg\\ffmpeg\\ffmpeg\\bin\\ffplay.exe";

function playWav(wav) {
  try {
    spawn(FFPLAY, ["-autoexit", "-nodisp", "-loglevel", "quiet", wav], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch { /* ignore */ }
}

function playMp3(mp3) {
  try {
    spawn(FFPLAY, ["-autoexit", "-nodisp", "-loglevel", "quiet", mp3], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch { /* ignore */ }
}
