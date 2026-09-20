// React 版面板：手写轮代码作答形态（jsdom + 真实构建产物，mock window.kanban IPC 桥）
// 2026-09-16 更新：React 版代码轮改为 **CodeMirror 6**（复用原生同一产物）——
//   本文件测 **CM 分支**（注入桩 loadPracticeEditor，断言宿主与回调接线）；
//   兜底分支（产物不可用 → textarea）在 react-panel-code-editor-fallback.render.test.mjs。
// （独立文件：构建产物是 ESM 单例，同一进程二次 import 不会重新挂载）
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const BUNDLE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer", "panel-react", "dist", "assets", "react-panel.js");

test("React 版手写轮：answerMode=code → 挂 CodeMirror（桩产物）+ 隐藏语音 + 提交链路仍读 answer", { skip: !existsSync(BUNDLE) && "产物未构建（先 npm run build:react-panel）" }, async () => {
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
    invStart: async () => ({ ok: true, round: 5, roundType: "手写/场景题", nextRoundType: "手写/场景题", answerMode: "code", question: "手写一个 debounce 函数", dimension: "代码能力", basis: "手写轮", criteria: "leading/trailing", boundary: "不考框架", depth: 0, totalRounds: 9 }),
    invAnswer: async () => ({ ok: true, total: 60, finished: false, question: "下一问", answerMode: "text" }),
    invStatus: async () => ({ ok: true, active: false }),
    interviewHistory: async () => ({ history: [] }),
  };
  // 桩产物：记录 create 的入参，验证接线（宿主/初始值/回调/高度）
  const calls = [];
  globalThis.window.loadPracticeEditor = async () => ({
    create(host, opts) {
      calls.push({ host, opts });
      host.dataset.cmMounted = "1";
      return { getValue: () => opts.initial || "", setValue: () => {}, focus: () => {}, destroy: () => { delete host.dataset.cmMounted; } };
    },
  });

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

  const host = document.querySelector('[data-role="iv-cm-host"]');
  assert.ok(host, "代码轮应渲染 CodeMirror 宿主（而非 textarea）");
  assert.equal(document.querySelector("textarea"), null, "代码轮不应再渲染 textarea（CM 接管）");
  assert.ok(await waitFor(() => calls.length > 0), "应调用桩产物挂载编辑器");
  assert.equal(typeof calls[0].opts.onChange, "function", "必须接 onChange（内容写回 answer，提交链路唯一数据源）");
  assert.equal(typeof calls[0].opts.onRun, "function", "必须接 onRun（Ctrl/Cmd+Enter 提交）");
  assert.equal(calls[0].opts.height, "240px", "高度与原生一致");
  assert.ok(!textOf(document.body).includes("语音作答"), "代码轮隐藏语音按钮");
  assert.ok(textOf(document.body).includes("💻 手写题 · 代码作答"), "代码模式标签");
  for (const id of intervals) clearInterval(id);
  globalThis.setInterval = realSetInterval;
  dom.window.close();
});
