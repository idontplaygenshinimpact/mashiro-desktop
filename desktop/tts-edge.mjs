// 真白语音：全部日语预设台词（GPT-SoVITS 真白声线 wav），零实时生成
// 显示中文 → 按关键词匹配场景 → 播放对应日语预设；未命中 → ack 通用应答
// 不再使用 edge-tts / VoiceVox 实时合成（内容对不上且开销大）
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

// ---------- 播放（ffplay 直接播，最可靠；mp3 同样走 ffplay；路径可配置/自动探测） ----------
