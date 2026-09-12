// React 版面板：手写轮代码作答形态（jsdom + 真实构建产物，mock window.kanban IPC 桥）
// 用户反馈 2026-09：手写题用纯文本框太难受 → 原生面板加代码编辑器，React 版保持同款形态
// （独立文件：构建产物是 ESM 单例，同一进程二次 import 不会重新挂载——与 react-panel.render 分进程跑）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-react", "dist", "assets", "react-panel.js");

test("React 版手写轮：answerMode=code → 代码形态（等宽 + 行号 + 隐藏语音 + Tab/Enter 缩进）", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost/" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.SVGElement = dom.window.SVGElement;
  globalThis.MutationObserver = dom.window.MutationObserver;
  // 面试会话视图有 1s 计时 setInterval（构建产物里是全局 setInterval → 默认绑到 Node 全局，
  // window.close() 清不掉 → 进程永不退出）。这里只**记录** interval id，测试收尾统一清掉
  // （不能把 setTimeout 重绑到 jsdom：jsdom 内部实现又会调全局 setTimeout → 无限递归）
  const intervals = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms, ...a) => { const id = realSetInterval(fn, ms, ...a); intervals.push(id); return id; };

  globalThis.window.kanban = {
    invStart: async () => ({ ok: true, round: 5, roundType: "手写/场景题", nextRoundType: "手写/场景题", answerMode: "code", question: "手写一个 debounce 函数", dimension: "代码能力", basis: "手写轮", criteria: "leading/trailing", boundary: "不考框架", depth: 0, totalRounds: 9 }),
    invAnswer: async () => ({ ok: true, total: 60, finished: false, question: "下一问", answerMode: "text" }),
    invStatus: async () => ({ ok: true, active: false }),
    interviewHistory: async () => ({ history: [] }),
  };

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

  const ta = document.querySelector("textarea");
  assert.ok(ta, "代码作答区存在");
  assert.match(ta.placeholder, /写代码作答/, "占位文案进入代码模式");
  assert.match(ta.style.fontFamily, /mono/i, "等宽字体（代码形态）");
  assert.ok(!textOf(document.body).includes("语音作答"), "代码轮隐藏语音按钮");
  assert.ok(textOf(document.body).includes("💻 手写题 · 代码作答"), "代码模式标签");
  // 行号槽（aria-hidden 的数字列）
  const gutterOf = () => [...document.querySelectorAll("div")].find((d) => d.getAttribute("aria-hidden") === "true" && /^[\d\s]+$/.test(d.textContent || "x"));
  assert.equal(gutterOf()?.textContent.trim(), "1", "行号槽初始为 1");

  // Tab → 两个空格；Enter（行尾 {）→ 换行 + 沿用缩进 + 多缩一级
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "function debounce(fn) {");
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(gutterOf()?.textContent.trim(), "1", "单行行号");
  const key = (k) => ta.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  ta.selectionStart = ta.selectionEnd = 0;
  key("Tab");
  assert.equal(ta.value, "  function debounce(fn) {", "Tab 插入两个空格");
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  key("Enter");
  assert.equal(ta.value, "  function debounce(fn) {\n    ", "Enter 自动缩进（沿用缩进 + { 后多一级）");
  assert.ok(await waitFor(() => gutterOf()?.textContent.trim().split("\n").length === 2), "行号随行数增长");
  for (const id of intervals) clearInterval(id); // 会话计时器回收（否则进程挂住）
  globalThis.setInterval = realSetInterval;
  dom.window.close();
});
