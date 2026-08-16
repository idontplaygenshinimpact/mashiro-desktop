// voice-pack.mjs 单测：语音播放互斥 + 防抖（验证调度逻辑；环境有 ffplay 时会真实播放短音频，无碍）
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 临时语音目录（避免依赖真实 assets/voice）
const voiceDir = mkdtempSync(path.join(tmpdir(), "mianshi-voice-"));
writeFileSync(path.join(voiceDir, "lines.json"), JSON.stringify({
  click: { files: ["click-1.wav"] },
  love: { files: ["love-1.wav"] },
}));
writeFileSync(path.join(voiceDir, "click-1.wav"), "x");
writeFileSync(path.join(voiceDir, "love-1.wav"), "x");
process.env.MIANSHI_TEST_VOICE_DIR = voiceDir;

const vp = await import("../desktop/voice-pack.mjs");

after(() => {
  try { rmSync(voiceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("playVoicePack：连续播放被防抖拦截（1.5s 窗口）", async () => {
  const r1 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r1.ok, true, "第一次播放成功");
  // 立即再播 → 防抖跳过
  const r2 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r2.ok, false);
  assert.equal(r2.debounced, true, "1.5s 内重复触发被防抖");
  // 等待防抖窗口过后恢复
  await new Promise((r) => setTimeout(r, 1600));
  const r3 = vp.playVoicePack(path.join(voiceDir, "love-1.wav"));
  assert.equal(r3.ok, true, "防抖窗口过后可再次播放");
});

test("playScene/playLongScene 走同一防抖（连点不叠加）", async () => {
  await new Promise((r) => setTimeout(r, 1600)); // 等上一个测试的防抖窗口过期
  const r1 = vp.playScene("click");
  assert.equal(r1.ok, true);
  const r2 = vp.playScene("click");
  assert.equal(r2.debounced, true, "playScene 防抖");
  const r3 = vp.playLongScene("love");
  assert.equal(r3.debounced, true, "playLongScene 防抖（同一窗口内）");
  await new Promise((r) => setTimeout(r, 1600));
  const r4 = vp.playLongScene("love");
  assert.equal(r4.ok, true, "长句播放恢复");
});

test("playScene：未命中场景返回 null 不崩溃", () => {
  const r = vp.playScene("no-such-scene");
  assert.equal(r, null);
});
