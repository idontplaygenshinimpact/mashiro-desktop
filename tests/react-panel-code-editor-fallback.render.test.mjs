// React 版面板：手写轮代码作答的**兜底分支**（产物不可用 → textarea，绝不留空白作答区）
// 2026-09-16：代码轮改为 CodeMirror 后，React 侧加 `cmFailed` 兜底；本文件专门测这条路径
// （不注入 window.loadPracticeEditor → 组件应回退 textarea，且保留等宽 + Tab/Enter 缩进）。
// 独立文件：构建产物是 ESM 单例，同一进程二次 import 不会重新挂载。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-react", "dist", "assets", "react-panel.js");

test("React 版手写轮兜底：无编辑器产物 → textarea（等宽 + Tab/Enter 缩进），不留空白作答区", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.MutationObserver = dom.window.MutationObserver;
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...a) => { const id = realSetInterval(fn, ms, ...a); intervals.push(id); return id; };

  globalThis.window.kanban = {
    invStart: async () => ({ ok: true, round: 5, roundType: "手写/场景题", answerMode: "code", question: "手写一个 debounce 函数", dimension: "代码能力", totalRounds: 9 }),
    invAnswer: async () => ({ ok: true, total: 60, finished: false, question: "下一问", answerMode: "text" }),
    invStatus: async () => ({ ok: true, active: false }),
    interviewHistory: async () => ({ history: [] }),
  };
  // 故意不注入 loadPracticeEditor：模拟"编辑器产物缺失"

  await import(new URL("../desktop/renderer/panel-react/dist/assets/react-panel.js", import.meta.url).href);
  const waitFor = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); }
    return false;
  };
  const textOf = (el) => el?.textContent || "";
  assert.ok(await waitFor(() => textOf(document.body).includes("开始面试")), "setup 渲染");
  [...document.querySelectorAll("button")].find((b) => textOf(b).includes("开始面试")).click();
  assert.ok(await waitFor(() => textOf(document.body).includes("手写一个 debounce")), "手写问题渲染");

  const ta = await (async () => {
    await waitFor(() => !!document.querySelector("textarea"));
    return document.querySelector("textarea");
  })();
  assert.ok(ta, "产物缺失时必须回退 textarea（不能是空白作答区）");
  assert.match(ta.placeholder, /写代码作答/, "占位文案进入代码模式");
  assert.match(ta.style.fontFamily, /mono/i, "兜底路径仍为等宽字体");

  // 兜底路径保留 Tab/Enter 缩进（CM 可用时由编辑器提供）
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "function debounce(fn) {");
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const key = (k) => ta.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  ta.selectionStart = ta.selectionEnd = 0;
  key("Tab");
  assert.equal(ta.value, "  function debounce(fn) {", "Tab 插入两个空格");
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  key("Enter");
  assert.equal(ta.value, "  function debounce(fn) {\n    ", "Enter 自动缩进（沿用缩进 + { 后多一级）");
  for (const id of intervals) clearInterval(id);
  globalThis.setInterval = realSetInterval;
  dom.window.close();
});
