// tests/speech-whisper.test.mjs —— whisper fallback 引擎分支单测（SPEECH_ENGINE=whisper）
// 覆盖：正常识别 + whisper 关键参数（language/task/chunk_length_s）正确透传 / 空结果
process.env.SPEECH_ENGINE = "whisper";
import { mock } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";

const speechUrl = new URL("../lib/speech.mjs", import.meta.url).href;

const fakeAsr = mock.fn(async () => ({ text: "你好世界" }));
mock.module("@xenova/transformers", { namedExports: { pipeline: async () => fakeAsr, env: {} } });

test("whisper 引擎识别 → 返回文本，参数含 chinese/transcribe/30s 分块", async () => {
  fakeAsr.mock.mockImplementation(async (_audio, opts) => {
    assert.equal(opts.language, "chinese", "应强制中文");
    assert.equal(opts.task, "transcribe");
    assert.equal(opts.chunk_length_s, 30, "长句应自动 30s 分块（防截断）");
    return { text: "你好世界" };
  });
  const speech = await import(speechUrl);
  const r = await speech.transcribeAudio(new Float32Array(16000));
  assert.equal(r.ok, true);
  assert.equal(r.text, "你好世界");
});

test("whisper 空结果 → 报未识别", async () => {
  fakeAsr.mock.mockImplementation(async () => ({ text: "  " }));
  const speech = await import(speechUrl);
  const r = await speech.transcribeAudio(new Float32Array(16000));
  assert.equal(r.ok, false);
  assert.match(r.error, /未识别/);
});

test("当前引擎名应为 whisper", async () => {
  const speech = await import(speechUrl);
  assert.equal(speech.getSpeechEngine(), "whisper");
});
