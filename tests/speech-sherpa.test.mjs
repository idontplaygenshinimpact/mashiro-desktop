// tests/speech-sherpa.test.mjs —— sherpa-onnx 引擎分支单测（SPEECH_ENGINE=sherpa）
// 覆盖：模型缺失提示 / 正常识别 / 包缺失回退 whisper / 过短拒绝（全部 mock，不碰真实模型）
process.env.SPEECH_ENGINE = "sherpa";
import { mock } from "node:test";
import test from "node:test";
import assert from "node:assert/strict";

const speechUrl = new URL("../lib/speech.mjs", import.meta.url).href;
// speech.mjs 内部引擎单例（recognizerPromise）跨用例缓存——每个用例独立模块实例（query 隔离）
let caseN = 0;
const freshSpeech = () => import(`${speechUrl}?case=${++caseN}`);

// 顶层只 mock 一次（mock.module 不允许重复），测试内用 mockImplementation 切换行为
const existsSync = mock.fn(() => true);
mock.module("node:fs", { namedExports: { existsSync } });

const createRequire = mock.fn(() => () => ({
  OfflineRecognizer: class {
    createStream() { return { acceptWaveform() {}, free() {} }; }
    decode() {}
    getResult() { return { text: "模拟识别的中文结果" }; }
  },
}));
mock.module("node:module", { namedExports: { createRequire } });

const fallbackAsr = async () => ({ text: "回退引擎的识别结果" });
mock.module("@xenova/transformers", { namedExports: { pipeline: async () => fallbackAsr, env: {} } });

test("模型文件缺失 → 提示运行 download-paraformer 脚本", async () => {
  existsSync.mock.mockImplementation(() => false);
  const speech = await freshSpeech();
  const r = await speech.transcribeAudio(new Float32Array(16000)); // 1s 有效长度
  assert.equal(r.ok, false);
  assert.match(r.error, /download-paraformer/);
});

test("模型存在 + sherpa 可用 → 返回识别文本", async () => {
  existsSync.mock.mockImplementation(() => true);
  createRequire.mock.mockImplementation(() => () => ({
    OfflineRecognizer: class {
      createStream() { return { acceptWaveform() {}, free() {} }; }
      decode() {}
      getResult() { return { text: "模拟识别的中文结果" }; }
    },
  }));
  const speech = await freshSpeech();
  const r = await speech.transcribeAudio(new Float32Array(16000));
  assert.equal(r.ok, true);
  assert.equal(r.text, "模拟识别的中文结果");
});

test("sherpa-onnx-node 包不可用 → 回退 whisper 仍可识别", async () => {
  existsSync.mock.mockImplementation(() => true);
  createRequire.mock.mockImplementation(() => () => {
    throw new Error("Cannot find module 'sherpa-onnx-node'");
  });
  const speech = await freshSpeech();
  const r = await speech.transcribeAudio(new Float32Array(16000));
  assert.equal(r.ok, true);
  assert.equal(r.text, "回退引擎的识别结果");
});

test("过短音频直接拒绝（不碰引擎）", async () => {
  existsSync.mock.mockImplementation(() => true);
  createRequire.mock.mockImplementation(() => () => {
    throw new Error("不应被调用");
  });
  const speech = await freshSpeech();
  const r = await speech.transcribeAudio(new Float32Array(100)); // <1600 采样
  assert.equal(r.ok, false);
  assert.match(r.error, /过短|无效/);
});

test("当前引擎名应为 sherpa", async () => {
  const speech = await freshSpeech();
  assert.equal(speech.getSpeechEngine(), "sherpa");
});
