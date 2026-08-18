// tests/vad.test.mjs —— 语音 VAD 裁剪单测
// vad.js 是浏览器普通 script（挂 window），这里沙箱执行拿纯函数测
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const code = readFileSync(new URL("../desktop/renderer/vad.js", import.meta.url), "utf8");
const sandbox = { window: {} };
const fakeModule = { exports: {} };
new Function("window", "module", code)(sandbox, fakeModule);
const { trimSilenceToVoice } = fakeModule.exports;
assert.equal(typeof trimSilenceToVoice, "function", "vad.js 应导出 trimSilenceToVoice");

const SR = 16000;

/** 生成测试音频：静音段 + 语音段 + 静音段 */
function makeAudio({ lead = 0.3, speech = 1.0, tail = 0.5, amp = 0.2 } = {}) {
  const pcm = new Float32Array(Math.round((lead + speech + tail) * SR));
  const s0 = Math.round(lead * SR);
  const s1 = Math.round((lead + speech) * SR);
  for (let i = s0; i < s1; i++) {
    // 带谐波的人类语音近似（基频 120Hz + 谐波）
    pcm[i] = amp * (0.6 * Math.sin(2 * Math.PI * 120 * i / SR) + 0.4 * Math.sin(2 * Math.PI * 240 * i / SR));
  }
  return pcm;
}

test("全程静音 → null", () => {
  const pcm = new Float32Array(SR); // 1s 全零
  assert.equal(trimSilenceToVoice(pcm, SR), null);
});

test("极低底噪（-80dBFS 噪声）也判定为静音", () => {
  const pcm = new Float32Array(SR * 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (Math.random() - 0.5) * 2e-4; // ~ -74dBFS
  assert.equal(trimSilenceToVoice(pcm, SR), null);
});

test("前后各 0.3s 静音 → 裁剪掉静音，保留语音主体", () => {
  const pcm = makeAudio({ lead: 0.3, speech: 1.0, tail: 0.3 });
  const out = trimSilenceToVoice(pcm, SR);
  assert.ok(out, "应有语音输出");
  // 输出应短于原长（裁掉了静音），且语音主体完整保留
  assert.ok(out.length < pcm.length, `裁剪后 ${out.length} 应短于原长 ${pcm.length}`);
  // 语音段起止（含 ±1 窗=100ms 余量）：0.3s 起、1.3s 止 → 输出起点 ≤0.4s，终点 ≥1.2s
  const startSec = out.byteOffset / 4 / SR;
  const endSec = (out.byteOffset / 4 + out.length) / SR;
  assert.ok(startSec <= 0.42, `起点 ${startSec.toFixed(3)}s 应 ≤0.42s`);
  assert.ok(endSec >= 1.18, `终点 ${endSec.toFixed(3)}s 应 ≥1.18s`);
});

test("长尾静音（1s 语音 + 1s 静音）→ 尾部静音被裁掉", () => {
  const pcm = makeAudio({ lead: 0.1, speech: 1.0, tail: 1.0 });
  const out = trimSilenceToVoice(pcm, SR);
  assert.ok(out, "应有语音输出");
  const endSec = (out.byteOffset / 4 + out.length) / SR;
  assert.ok(endSec <= 1.3, `终点 ${endSec.toFixed(3)}s 应 ≤1.3s（1s 语音 + 余量）`);
});

test("全程语音（无静音）→ 基本保留全长（只留余量）", () => {
  const pcm = makeAudio({ lead: 0, speech: 1.0, tail: 0 });
  const out = trimSilenceToVoice(pcm, SR);
  assert.ok(out, "应有语音输出");
  assert.ok(out.length >= pcm.length * 0.9, `应保留绝大部分（${out.length}/${pcm.length}）`);
});

test("空数组 → null；默认采样率 16000 可用", () => {
  assert.equal(trimSilenceToVoice(new Float32Array(0), SR), null);
  const pcm = makeAudio({ lead: 0.2, speech: 0.6, tail: 0.2 });
  const out = trimSilenceToVoice(pcm); // 不传采样率
  assert.ok(out, "默认采样率应正常工作");
});
