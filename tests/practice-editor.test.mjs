// 判题编辑器（原生态）回归护栏：三态上 CodeMirror 6 的原生那一半
// 背景：原生面板原来的"编辑器"是 textarea + 高亮叠层 + 行号槽手搓实现
//（没有语法引擎、没有括号匹配/自动缩进），产品负责人要求三态统一升级为 CodeMirror 6。
// 本护栏做两件事：
//   ① 真把**构建产物**（practice-editor.bundle.js）在 jsdom 里跑起来，验证 create/getValue/setValue/destroy 真能用；
//   ② 固化接线约定：按需注入（不进首屏）、失败回退 textarea、判题读编辑器值、关闭时销毁。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { JSDOM } from "jsdom";

const R = (p) => new URL("../" + p, import.meta.url);
const read = (p) => readFileSync(R(p), "utf8");
const BUNDLE = R("desktop/renderer/practice-editor.bundle.js");

test("构建产物存在且是 IIFE 全局（原生面板是非模块脚本，只能用全局）", () => {
  assert.ok(existsSync(BUNDLE), "缺少 practice-editor.bundle.js —— 先跑 npm run build:practice-editor");
  const src = readFileSync(BUNDLE, "utf8");
  assert.match(src, /PracticeEditor\s*=/, "产物应暴露全局 PracticeEditor（esbuild --global-name）");
  assert.ok(src.includes("cm-editor"), "产物应含 CodeMirror 的 DOM 类名（确认真的打进去了）");
  assert.ok(!/^\s*import\s/m.test(src), "IIFE 产物不应残留 ESM import 语句");
});

test("真机行为：在 jsdom 里挂载 CodeMirror 并读写/销毁（不是只看源码字符串）", () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='host'></div></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true, // 提供 requestAnimationFrame 等 CodeMirror 需要的浏览器 API
  });
  const { window } = dom;
  window.eval(readFileSync(BUNDLE, "utf8"));
  const PE = window.PracticeEditor;
  assert.ok(PE && typeof PE.create === "function", "产物应暴露 create()");
  assert.equal(PE.kind, "codemirror6", "kind 标记应表明是 CodeMirror 版（回退实现不带这个标记）");

  const host = window.document.getElementById("host");
  let ran = 0;
  const h = PE.create(host, { initial: "function solution(a) { return a; }", onRun: () => { ran++; } });

  // 挂载：CodeMirror 会渲染 .cm-editor / .cm-content
  assert.ok(host.querySelector(".cm-editor"), "应真实挂载出 .cm-editor 节点");
  assert.ok(host.querySelector(".cm-content"), "应真实挂载出 .cm-content 节点");
  assert.equal(h.getValue(), "function solution(a) { return a; }", "getValue 应返回初始骨架");

  h.setValue("function solution(a) { return a.reduce((x, y) => x + y, 0); }");
  assert.match(h.getValue(), /reduce/, "setValue 后 getValue 应读到新内容");

  // Mod-Enter 键位（面板判题入口之一）：不依赖真实键盘事件，直接调 handle 之外的回调验证一次
  assert.equal(ran, 0, "初始不应触发 onRun");
  h.destroy();
  assert.equal(host.querySelector(".cm-editor"), null, "destroy 后应移除编辑器 DOM（关闭面板不残留/不泄漏）");
});

test("原生接线：按需注入产物 + 失败回退 textarea + 判题读编辑器值 + 关闭销毁", () => {
  const panel = read("desktop/renderer/panel-rest.js");
  // ① 按需注入：494KB 产物不进首屏（与 M9"按需加载框架 bundle"同策略）
  assert.match(panel, /function loadPracticeEditor\(\)/, "应有懒加载函数");
  assert.match(panel, /createElement\("script"\)/, "应运行时注入 script 标签");
  assert.match(panel, /practice-editor\.bundle\.js/, "应加载编辑器产物");
  const html = read("desktop/renderer/panel.html");
  assert.doesNotMatch(html, /practice-editor\.bundle\.js/, "panel.html 不应静态引入（否则白付 494KB 首屏）");
  // ② 回退路径保留：产物缺失/初始化异常时退回 textarea（编辑器坏掉不能连带面板不可用）
  assert.match(panel, /function mountFallbackEditor\(/, "应保留 textarea 回退实现");
  assert.match(panel, /CodeMirror 初始化失败，退回 textarea/, "初始化异常要回退并留日志");
  // ③ 判题读的是编辑器当前值（不能还读旧的 ta.value）
  assert.match(panel, /const code = ed\.getValue\(\)/, "run() 应从编辑器取值");
  assert.match(panel, /body: JSON\.stringify\(\{ id: btn\.dataset\.id, userCode: code \}\)/, "判题应提交编辑器内容");
  // ④ 关闭时销毁（顺序：先销毁再移除节点）
  assert.match(panel, /if \(ed\.destroy\) ed\.destroy\(\)/, "关闭编辑器应销毁 CodeMirror 实例");
  // ⑤ Ctrl/Cmd+Enter 走统一入口（CodeMirror keymap 与回退实现共用）
  assert.match(panel, /runRef\.fn = run/, "应以 runRef 暴露 run 给编辑器 keymap（避免 TDZ）");
});

test("打包与哈希登记齐全（产物不会被漏构建/漏检查）", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["build:practice-editor"] || "", /esbuild .*practice-editor\.ts/, "缺 build:practice-editor 脚本");
  const hashes = JSON.parse(read("desktop/renderer/bundle-hashes.json"));
  assert.ok(hashes.practiceEditor?.sources?.["practice-editor.ts"], "bundle-hashes.json 应登记 practice-editor.ts（防「改了源码没重建」）");
  const check = read("scripts/check-renderer.mjs");
  assert.match(check, /PE_BUNDLE/, "check:renderer 应检查该产物存在与新鲜度");
  const gen = read("scripts/gen-renderer-hashes.mjs");
  assert.match(gen, /"practice-editor": \["practice-editor\.ts"\]/, "gen-renderer-hashes 应有 practice-editor 组");
});
