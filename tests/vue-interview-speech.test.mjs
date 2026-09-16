// Vue 版模拟面试「语音作答」回归护栏（前端三态补齐工单第 ⑨ 种样子货）
// 历史：React 面试 Tab 已支持语音作答，Vue 面试此前完全没有——若再出现"动作空实现"要在此档住。
// 本护栏是源码级静态断言（读 useInterview.js + Interview.vue，不看压缩产物）：
// ① 必须走同一 IPC 桥 window.kanban.speechToText ② 有录音状态机（未录音/录音中/转写中）
// ③ 有卸载清理（onUnmounted 掐 mic 流）④ 有空转写/失败提示分支（不许静默）。
// 其中任何一处功能被删掉（回退成"空实现"）时，对应断言即红 → 达成"没这段功能就失败"的护栏作用。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const VUE = path.join(ROOT, "desktop", "renderer", "panel-vue-review", "src");
const useInterview = readFileSync(path.join(VUE, "useInterview.js"), "utf8");
const interviewVue = readFileSync(path.join(VUE, "tabs", "Interview.vue"), "utf8");

test("Vue 面试语音作答：走同一 IPC 桥 speechToText（不另造协议）", () => {
  assert.match(useInterview, /window\.kanban\.speechToText\s*\(/, "useInterview.js 调用同一 IPC 桥 speechToText");
  assert.match(useInterview, /speechToText\s*\(audio\)/, "把 16k Float32 录音数据传给 speechToText");
  assert.match(interviewVue, /🎤 语音作答/, "Interview.vue 有「🎤 语音作答」入口（与 React 版同交互）");
});

test("Vue 面试语音作答：有录音状态机（未录音/录音中/转写中）", () => {
  assert.match(useInterview, /micState\s*=\s*ref\(\s*"idle"\s*\)/, "micState 初始为「未录音」");
  assert.match(useInterview, /"recording"/, "状态机覆盖「录音中」");
  assert.match(useInterview, /"transcribing"/, "状态机覆盖「转写中」");
  assert.match(useInterview, /navigator\.mediaDevices\.getUserMedia/, "录音走 getUserMedia（真实麦克风采集）");
  assert.match(interviewVue, /⏹ 停止/, "录音中提供「⏹ 停止」按钮（停止并转写）");
  assert.match(interviewVue, /✖ 取消/, "录音中提供「✖ 取消」按钮（丢弃样本不送 ASR）");
});

test("Vue 面试语音作答：卸载时清理麦克风流（onUnmounted 不泄漏 mic）", () => {
  assert.match(useInterview, /onUnmounted\s*\(/, "组件卸载钩子存在");
  assert.match(useInterview, /getTracks\(\)\.forEach\(\s*\(t\)\s*=>\s*t\.stop\(\)\s*\)/, "卸载/停机都逐个停掉麦克风轨道");
  assert.match(useInterview, /micRef\.value\s*=\s*null/, "清理后释放资源句柄，避免悬挂引用");
});

test("Vue 面试语音作答：空转写与失败都有可见提示（不许静默失败）", () => {
  // 太短的录音被本地拦截，提示重说（同 React 版阈值 8000 采样）
  assert.match(useInterview, /语音太短，请再说一次/, "空/过短录音给明确提示而不是静默丢弃");
  // 后端返回无 ok.text（空结果或后端报错）时给可见错误
  assert.match(useInterview, /识别失败，请重试/, "后端空结果/报错时回退到「识别失败，请重试」提示");
  assert.match(useInterview, /r\?\.error/, "透传后端 error 字段，不吞掉真实错误");
  // 模板里确实把 micErr 渲染出来（可见，而不是 console 里悄悄打）
  assert.match(interviewVue, /\{\{\s*micErr\s*\}\}/, "Interview.vue 渲染 micErr 提示文案");
});
