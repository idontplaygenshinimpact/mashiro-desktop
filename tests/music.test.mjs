// music.mjs 单测：音乐扫描/播放状态/音量/自动播放（不真实播放，只验证逻辑）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 用临时音乐目录替换模块内的 MUSIC_DIR（动态 import + 注入）
const fakeMusicDir = mkdtempSync(path.join(tmpdir(), "mianshi-music-"));
process.env.MIANSHI_TEST_MUSIC_DIR = fakeMusicDir;
const url = new URL("../lib/music.mjs", import.meta.url);
url.searchParams.set("t", Date.now().toString(36));
const music = await import(url.href);

beforeEach(() => {
  // 清空临时目录
  try { rmSync(fakeMusicDir, { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(fakeMusicDir, { recursive: true });
});
after(() => { try { rmSync(fakeMusicDir, { recursive: true, force: true }); } catch { /* ignore */ } });

test("scanMusic：目录为空返回空列表", () => {
  assert.deepEqual(music.scanMusic(), []);
});

test("scanMusic：识别音频扩展名 + music.json 曲名覆盖 + 非音频忽略", () => {
  writeFileSync(path.join(fakeMusicDir, "op2.mp3"), "x");
  writeFileSync(path.join(fakeMusicDir, "ed1.flac"), "x");
  writeFileSync(path.join(fakeMusicDir, "readme.txt"), "x"); // 非音频忽略
  writeFileSync(path.join(fakeMusicDir, "bgm.m4a"), "x");
  writeFileSync(path.join(fakeMusicDir, "music.json"), JSON.stringify({ tracks: { "op2.mp3": "夢の続き（OP2）" } }));
  const list = music.scanMusic();
  assert.equal(list.length, 3);
  const names = list.map((t) => t.name);
  assert.ok(names.includes("夢の続き（OP2）"), "music.json 曲名覆盖");
  assert.ok(names.includes("ed1") && names.includes("bgm"), "其余用文件名（去扩展名）");
  assert.ok(!list.some((t) => t.file.endsWith("readme.txt")), "非音频忽略");
  assert.ok(list.every((t) => t.file.startsWith(fakeMusicDir)), "绝对路径");
});

test("playMusic：无文件 → 错误提示不崩溃", () => {
  const r = music.playMusic();
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("assets/music/"));
});

test("状态机：音量钳制 0-100 + setMusicPrefs 注入", () => {
  music.setMusicPrefs({ volume: 88, autoplay: true });
  let st = music.getMusicState();
  assert.equal(st.volume, 88);
  assert.equal(st.autoplayOn, true);
  music.setMusicVolume(999);
  st = music.getMusicState();
  assert.equal(st.volume, 100, "音量上限 100");
  music.setMusicAutoplay(false);
  assert.equal(music.getMusicState().autoplayOn, false);
  // 恢复默认
  music.setMusicPrefs({ volume: 70, autoplay: false });
});

test("stopMusic：未播放时停止不崩溃", () => {
  const r = music.stopMusic();
  assert.equal(r.ok, true);
  assert.equal(r.playing, false);
});
