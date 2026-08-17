// voice-pack.mjs 单测：语音播放互斥 + 防抖 + 长句保护（mock spawn 控制播放进程状态）
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// 临时语音目录（避免依赖真实 assets/voice）
const voiceDir = mkdtempSync(path.join(tmpdir(), "mianshi-voice-"));
writeFileSync(path.join(voiceDir, "lines.json"), JSON.stringify({
  click: { files: ["click-1.wav"] },
  love: { files: ["love-1.wav"] },
}));
writeFileSync(path.join(voiceDir, "click-1.wav"), "x");
writeFileSync(path.join(voiceDir, "love-1.wav"), "x");
// 长句目录（长句保护测试用）
mkdirSync(path.join(voiceDir, "long"));
writeFileSync(path.join(voiceDir, "long", "long-1.wav"), "x");
process.env.MIANSHI_TEST_VOICE_DIR = voiceDir;

// mock node:child_process：spawn 返回可控假进程（保留真实 spawnSync 供 ffplay 探测）
const realCp = await import("node:child_process");
const spawned = [];
function fakeSpawn(cmd, args, opts) {
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.unref = () => {};
  child.pid = 1000 + spawned.length;
  spawned.push(child);
  return child;
}
mock.module("node:child_process", {
  namedExports: { spawn: fakeSpawn, spawnSync: realCp.spawnSync, exec: realCp.exec },
});

const vp = await import("../desktop/voice-pack.mjs");

after(() => {
  try { rmSync(voiceDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("playVoicePack：连续播放被防抖拦截（1.5s 窗口）", async () => {
  const r1 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r1.ok, true, "第一次播放成功");
  // 立即再播 → 防抖跳过
  const r2 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r2.ok, false);
  assert.equal(r2.debounced, true, "1.5s 内重复触发被防抖");
  // 等待防抖窗口过后恢复
  await sleep(2600);
  const r3 = vp.playVoicePack(path.join(voiceDir, "love-1.wav"));
  assert.equal(r3.ok, true, "防抖窗口过后可再次播放");
  await sleep(2600); // 清防抖窗口，供后续测试
});

test("playScene/playLongScene 走同一防抖（连点不叠加）", async () => {
  const r1 = vp.playScene("click");
  assert.equal(r1.ok, true);
  const r2 = vp.playScene("click");
  assert.equal(r2.debounced, true, "playScene 防抖");
  const r3 = vp.playLongScene("love");
  assert.equal(r3.debounced, true, "playLongScene 防抖（同一窗口内）");
  await sleep(2600);
  const r4 = vp.playLongScene("love");
  assert.equal(r4.ok, true, "长句播放恢复");
  await sleep(2600); // 清防抖窗口
});

test("playScene：未命中场景返回 null 不崩溃", () => {
  const r = vp.playScene("no-such-scene");
  assert.equal(r, null);
});

test("长句播放中不被打断（busy），短句可打断", async () => {
  await sleep(2600); // 确保防抖窗口已过
  // 播长句（路径含 /long/）→ 假进程进入"播放中"状态
  const longFile = path.join(voiceDir, "long", "long-1.wav");
  const r1 = vp.playVoicePack(longFile);
  assert.equal(r1.ok, true, "长句开始播放");
  await sleep(2600); // 过防抖窗口
  // 长句播放中再触发短句 → 不打断（busy，不 kill）
  const r2 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r2.ok, false);
  assert.equal(r2.busy, true, "长句播放中忽略新触发");
  assert.equal(spawned[spawned.length - 1].killed, false, "长句进程未被 kill");
  // 长句"播完"（exit）→ 状态清理 → 可再播
  spawned[spawned.length - 1].emit("exit", 0);
  await sleep(2600);
  const r3 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r3.ok, true, "长句结束后可正常播放");
  // 短句播放中播长句 → 允许打断（ok）
  await sleep(2600);
  const r4 = vp.playVoicePack(path.join(voiceDir, "click-1.wav"));
  assert.equal(r4.ok, true, "短句开播");
  await sleep(2600);
  const r5 = vp.playVoicePack(longFile);
  assert.equal(r5.ok, true, "短句播放中可切长句（打断无感）");
  await sleep(2600);
});
