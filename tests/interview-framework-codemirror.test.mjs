// 框架版面试「代码作答」三态对齐 护栏（2026-09-16）
// 背景：原生面板的面试手写轮已上 CodeMirror 6（a7bc4f4），但框架版没跟上——
//   · React 版（panel.jsx）识别了 answerMode="code" 却仍是 textarea（手搓行号 + Tab 缩进）；
//   · Vue 版（Interview.vue）**完全不识别 answerMode**，一直是纯 textarea。
// 本护栏要求三态都：① 代码轮用 CodeMirror（复用原生同一产物，不各自打包）；② answer 仍是唯一数据源
// （CM 的 onChange 写回，提交链路零改动）；③ CM 挂载失败要有 textarea 兜底（不留空白作答区）；
// ④ 轮次/模式切换要销毁旧实例（不泄漏、不双挂）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const react = read("desktop/renderer/panel-react/src/panel.jsx");
const vue = read("desktop/renderer/panel-vue-review/src/tabs/Interview.vue");
const native = read("desktop/renderer/panel-study.js");

test("三态都复用同一个 CodeMirror 产物（loadPracticeEditor），不各自打包", () => {
  for (const [name, src] of [["原生", native], ["React", react], ["Vue", vue]]) {
    assert.match(src, /loadPracticeEditor/, `${name}：应复用全局 loadPracticeEditor（同一 practice-editor.bundle.js）`);
  }
  // 三个框架产物里都不应各自 bundle CodeMirror（体积与版本一致性）
  assert.doesNotMatch(react, /from "@codemirror/, "React 面试组件不应自己 import CodeMirror（应复用原生产物）");
  assert.doesNotMatch(vue, /from "@codemirror/, "Vue 面试组件不应自己 import CodeMirror（应复用原生产物）");
});

test("React 版：代码轮挂 CodeMirror（answerMode=code 判定 + onChange 写回 + 失败兜底）", () => {
  assert.match(react, /session\?\.answerMode === "code"/, "应按 answerMode 判定代码轮");
  assert.match(react, /cm = typeof loader\.loadPracticeEditor === "function"/, "应通过全局加载器取编辑器");
  assert.match(react, /onChange: \(v\) => setAnswer\(String\(v\)\)/, "CM 内容必须写回 answer（唯一数据源）");
  assert.match(react, /isCode && !cmFailed/, "渲染应按 isCode + 未失败分流");
  assert.match(react, /setCmFailed\(true\)/, "挂载失败要置失败标记（走 textarea 兜底，不留空白区）");
  assert.match(react, /cmRef\.current\?\.destroy\?\.\(\)/, "轮次切换/卸载要销毁 CM 实例");
});

test("Vue 版：代码轮挂 CodeMirror（此前完全不识别 answerMode）", () => {
  assert.match(vue, /answerMode === "code"/, "Vue 版必须识别 answerMode（此前完全没有）");
  assert.match(vue, /loadPracticeEditor/, "应复用全局加载器");
  assert.match(vue, /answer\.value = String\(v\)/, "CM 内容必须写回 answer");
  assert.match(vue, /v-if="isCode && !cmFailed"/, "渲染应按 isCode + 未失败分流");
  assert.match(vue, /cmFailed\.value = true/, "挂载失败要置失败标记（走 textarea 兜底）");
  assert.match(vue, /onBeforeUnmount\(destroyCodeEditor\)/, "组件卸载要销毁 CM 实例");
  assert.match(vue, /watch\(\[isCode, \(\) => st\.session\?\.round\]/, "轮次/模式切换应重挂并销毁旧实例");
});

test("手搓行号列已移除（避免与 CM 自带行号槽叠成两条）", () => {
  assert.doesNotMatch(react, /gutterText/, "React 版不应再渲染手搓行号列");
  assert.doesNotMatch(vue, /gutterText/, "Vue 版不应有手搓行号列");
});
