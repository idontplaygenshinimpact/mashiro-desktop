// tests/speech-segment.test.mjs —— 长音频分段（真实面试回答跨句串位修复）+ 术语/同音词纠错
// 背景（实测脚本 scripts/_asr-ab.mjs）：90.5s「边想边说」音频整段送离线 paraformer 会跨句串位
// （"模拟面试系统它是整个项目的核心模块" → "模拟面繁请求为是整个项目的核心模块"），分段后恢复正确。
process.env.SPEECH_ENGINE = "sherpa";
process.env.SPEECH_SEG_MAX_SEC = "14";
import { mock } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";

const speechUrl = new URL("../lib/speech.mjs", import.meta.url).href;
let caseN = 0;
const freshSpeech = () => import(`${speechUrl}?seg=${++caseN}`);

// 记录识别调用次数/入参长度（验证"长音频确实被分段送识别"）
const calls = [];
mock.module("node:fs", { namedExports: { existsSync: mock.fn(() => true) } });
mock.module("node:module", {
  namedExports: {
    createRequire: mock.fn(() => () => ({
      OfflineRecognizer: class {
        createStream() {
          return {
            acceptWaveform({ samples }) { calls.push(samples.length); },
            free() {},
          };
        }
        decode() {}
        getResult() { return { text: `段${calls.length}结果` }; }
      },
    })),
  },
});

/** 造一段 PCM：bursts 个语音爆发（amp 0.3），之间 gapSec 静音 */
function makePcm({ rate = 16000, bursts, burstSec, gapSec }) {
  const total = Math.round(rate * (bursts * burstSec + (bursts - 1) * gapSec));
  const pcm = new Float32Array(total);
  for (let b = 0; b < bursts; b++) {
    const start = Math.round(rate * b * (burstSec + gapSec));
    const end = Math.min(total, start + Math.round(rate * burstSec));
    for (let i = start; i < end; i++) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate);
  }
  return pcm;
}

test("segmentVoice：静音分隔的多句 → 段边界落在静音里（不切在句子中间）", async () => {
  const { segmentVoice } = await freshSpeech();
  // 8 句 3s + 7 段 1.5s 静音 = 34.5s > 上限 14s → 必须切；切点应落在静音区
  const pcm = makePcm({ bursts: 8, burstSec: 3, gapSec: 1.5 });
  const segs = segmentVoice(pcm, 16000, 14);
  assert.ok(segs.length >= 3, `34.5s 应切 ≥3 段，实际 ${segs.length}`);
  for (const s of segs) assert.ok((s.end - s.start) / 16000 <= 14.01, "每段不超过上限");
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i].start >= segs[i - 1].end, "段不应重叠");
  // 每个切点都必须落在"静音区"（burst 之间的间隔）——即切点前后 200ms 内无 burst 覆盖
  const rate = 16000;
  const inBurst = (sample) => {
    for (let b = 0; b < 8; b++) {
      const st = b * (3 + 1.5) * rate, en = st + 3 * rate;
      if (sample > st && sample < en) return true;
    }
    return false;
  };
  for (let i = 1; i < segs.length; i++) {
    assert.equal(inBurst(segs[i - 1].end), false, `切点 ${segs[i - 1].end} 落在语音中间`);
  }
});

test("segmentVoice：全程连续语音（无静音）→ 仍按上限切分（底噪法失效时的兜底）", async () => {
  const { segmentVoice } = await freshSpeech();
  const pcm = makePcm({ bursts: 1, burstSec: 40, gapSec: 0 });
  const segs = segmentVoice(pcm, 16000, 14);
  assert.ok(segs.length >= 3, `40s 连续语音应切 ≥3 段，实际 ${segs.length}`);
  for (const s of segs) assert.ok((s.end - s.start) / 16000 <= 14.01, "每段不超过上限");
});

test("segmentVoice：短音频不切（零行为变化）", async () => {
  const { segmentVoice } = await freshSpeech();
  const pcm = makePcm({ bursts: 1, burstSec: 3, gapSec: 0 });
  const segs = segmentVoice(pcm, 16000, 14);
  assert.equal(segs.length, 1);
});

test("transcribeAudio：长音频自动分段送识别并拼接（段间补「，」）", async () => {
  calls.length = 0;
  const speech = await freshSpeech();
  const pcm = makePcm({ bursts: 3, burstSec: 12, gapSec: 1 }); // 38s、按 14s 上限应切 ≥3 段
  const r = await speech.transcribeAudio(pcm);
  assert.equal(r.ok, true);
  assert.ok(calls.length >= 3, `识别应被调用 ≥3 次（实际 ${calls.length}）`);
  assert.ok(calls.every((n) => n / 16000 <= 14.01), "每次送入的音频不超过分段上限");
  assert.ok(r.text.includes("，"), "分段时间应以「，」拼接");
  assert.equal(r.segments, calls.length);
});

test("transcribeAudio：短音频单次识别（不拼接、无 segments 字段）", async () => {
  calls.length = 0;
  const speech = await freshSpeech();
  const r = await speech.transcribeAudio(makePcm({ bursts: 1, burstSec: 2, gapSec: 0 }));
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(r.segments, undefined);
});

test("fixTerms：实测真实转写的同音词/术语错误被纠正", async () => {
  const { fixTerms } = await freshSpeech();
  // 用户真实面试转写样本（desktop-main.log 10:14/10:18）中的错误
  assert.equal(fixTerms("我的主要技术战士 vu 和 React"), "我的主要技术栈是 Vue 和 React");
  assert.equal(fixTerms("六台的有限装态机"), "六态的有限状态机");
  assert.equal(fixTerms("我用了一个有线状态机"), "我用了一个有限状态机");
  assert.equal(fixTerms("我还做了 jd 匹配和修改模拟"), "我还做了 JD 匹配和简历解析");
  assert.equal(fixTerms("使用了 fsm 去预定了一个 transit"), "使用了 FSM 去预定了一个 transition");
  // 分段拼接引入的逗号断词
  assert.equal(fixTerms("熟悉 no，js 和 typscript"), "熟悉 Node.js 和 TypeScript");
  assert.equal(fixTerms("用 web，pack 打包"), "用 Webpack 打包");
  // 中文正常文本不受影响
  assert.equal(fixTerms("我今天复习了闭包和事件循环"), "我今天复习了闭包和事件循环");
});
