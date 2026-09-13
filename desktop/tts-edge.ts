// 真白语音：日语预设台词（GPT-SoVITS 真白声线 wav）优先 + 实时合成兜底
// 显示中文 → 按关键词匹配场景 → 播放对应日语预设（零延迟）；未命中 → 实时合成（main 侧 tts:speak-realtime）
// 全量 TS 升级工单阶段 4（桌面）：实现迁至 tts-edge.ts，tts-edge.mjs 保留同名薄桶（主进程按 .mjs 路径加载零改动）
import { matchVoicePack, playVoicePack, pickSceneFile } from "./voice-pack.mjs";

/** 错误信息提取（catch 变量在 strict 下是 unknown） */
const eMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 播放结果（语音包/实时合成都走这条形状） */
export interface SpeakResult {
  ok?: boolean;
  error?: string;
  mode?: "preset" | "miss";
  scene?: string;
  file?: string;
  path?: string;
}

// ---------- 入口 ----------
export async function speak(text: unknown): Promise<SpeakResult> {
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
    console.log(`[tts] 语音包匹配失败: ${eMsg(e)}`);
  }
  // 兜底：ack 通用应答（matchVoicePack 已含 ack，理论上到不了这里）
  try {
    const ack = pickSceneFile("ack");
    if (ack) return playVoicePack(ack);
  } catch { /* ignore */ }
  return { ok: false, error: "无可用语音" };
}

/** 仅预设模式（实时语音链用）：命中预设 → 播并返回 {mode:'preset'}；未命中返回 {mode:'miss'}（不播 ack，调用方走实时合成） */
export async function speakPresetOnly(text: unknown): Promise<SpeakResult> {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { mode: "miss" };
  try {
    const hit = matchVoicePack(clean);
    if (hit) {
      await playVoicePack(hit.file);
      return { mode: "preset", scene: hit.scene, file: hit.file };
    }
  } catch (e) {
    console.log(`[tts] 语音包匹配失败: ${eMsg(e)}`);
  }
  return { mode: "miss" };
}

/** 预设文件路径（实时语音 prepare 阶段用）：命中返回 {mode:'preset', path}；未命中 {mode:'miss'}——不播放不 ack */
export async function presetFile(text: unknown): Promise<SpeakResult> {
  const clean = String(text || "").trim().slice(0, 200);
  if (!clean) return { mode: "miss" };
  try {
    const hit = matchVoicePack(clean);
    if (hit) return { mode: "preset", path: hit.file, scene: hit.scene };
  } catch (e) {
    console.log(`[tts] 语音包匹配失败: ${eMsg(e)}`);
  }
  return { mode: "miss" };
}

// ---------- 播放（ffplay 直接播，最可靠；mp3 同样走 ffplay；路径可配置/自动探测） ----------
