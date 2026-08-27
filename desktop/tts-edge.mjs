// 真白语音：日语预设台词（GPT-SoVITS 真白声线 wav）优先 + 实时合成兜底
// 显示中文 → 按关键词匹配场景 → 播放对应日语预设（零延迟）；未命中 → 实时合成（main 侧 tts:speak-realtime）
import { matchVoicePack, playVoicePack, pickSceneFile } from "./voice-pack.mjs";

// ---------- 入口 ----------
export async function speak(text) {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { ok: false, error: "empty" };
  // 语音包优先：按中文关键词匹配场景 → 直接播日语预设（零延迟）
  try {
    const hit = matchVoicePack(clean);
    if (hit) {
      console.log(`[tts] 语音包命中（${hit.scene}）→ ${hit.file}`);
      return playVoicePack(hit.file);
    }
  } catch (e) {
    console.log(`[tts] 语音包匹配失败: ${e.message}`);
  }
  // 兜底：ack 通用应答（matchVoicePack 已含 ack，理论上到不了这里）
  try {
    const ack = pickSceneFile("ack");
    if (ack) return playVoicePack(ack);
  } catch { /* ignore */ }
  return { ok: false, error: "无可用语音" };
}

/** 仅预设模式（实时语音链用）：命中预设 → 播并返回 {mode:'preset'}；未命中返回 {mode:'miss'}（不播 ack，调用方走实时合成） */
export async function speakPresetOnly(text) {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { mode: "miss" };
  try {
    const hit = matchVoicePack(clean);
    if (hit) {
      await playVoicePack(hit.file);
      return { mode: "preset", scene: hit.scene, file: hit.file };
    }
  } catch (e) {
    console.log(`[tts] 语音包匹配失败: ${e.message}`);
  }
  return { mode: "miss" };
}

/** 预设文件路径（实时语音 prepare 阶段用）：命中返回 {mode:'preset', path}；未命中 {mode:'miss'}——不播放不 ack */
export async function presetFile(text) {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { mode: "miss" };
  try {
    const hit = matchVoicePack(clean);
    if (hit) return { mode: "preset", path: hit.file, scene: hit.scene };
  } catch (e) {
    console.log(`[tts] 语音包匹配失败: ${e.message}`);
  }
  return { mode: "miss" };
}

// ---------- 播放（ffplay 直接播，最可靠；mp3 同样走 ffplay；路径可配置/自动探测） ----------
