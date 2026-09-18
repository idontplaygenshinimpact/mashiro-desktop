// 真浏览器几何护栏（2026-09-16）：jsdom 不做排版，量不出宽高——"编辑器被压成一条窄条"这类
// 布局塌陷它永远发现不了。本条用真 Chromium 断言"CodeMirror 必须撑满它的宿主"。
// 由来：视觉复核（OpenRouter 视觉模型看截图）发现面试手写轮里 CM 只有 39px 宽（= 行号槽宽度），
// 几何数据坐实后修在 panel.css（`.iv-editor` 是 flex 行，CM 作为 flex 子项按 min-content 收缩；
// JS 里加了 .iv-cm-host 标记类但**没有配 CSS**）。本护栏盯住"挂了 CM 就要占满宿主"这条不变量。
// CI 无浏览器二进制时自动跳过（静态护栏仍在）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const PANEL = fileURLToPath(new URL("../desktop/renderer/panel.html", import.meta.url));

/** 启动真浏览器；不可用时返回 null（调用方 skip） */
async function openPanel(t) {
  let chromium;
  try { ({ chromium } = await import("playwright-core")); } catch { t.skip("未安装 playwright-core"); return null; }
  const exe = (() => { try { return chromium.executablePath(); } catch { return null; } })();
  if (!exe || !existsSync(exe)) { t.skip("没有 Playwright 浏览器二进制（CI 常见）——跳过几何断言"); return null; }
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  await page.addInitScript(() => {
    const base = { ok: true, base: "http://127.0.0.1:8899", plan: { date: "2026-09-16", items: [] }, files: [], progress: { status: "idle" } };
    const acm = { id: "acm-x", title: "区间和", category: "algorithm", difficulty: 2, frequency: 2, timeLimit: 10, mode: "acm", done: false, wrongCount: 0, description: "输入格式：…", skeleton: "// ACM\n" };
    const stubs = {
      getData: base, studyPlan: { ok: true, plan: base.plan },
      invStart: { ok: true, session: { round: 1, roundType: "手写轮" }, question: "手写一个防抖函数", answerMode: "code", dimension: "代码", criteria: "c", boundary: "b" },
    };
    const W = /** @type {any} */ (window);
    W.kanban = new Proxy({}, { get: (_t, k) => async () => (stubs[k] ?? base) });
    W.fetch = async (url) => {
      const u = String(url);
      const j = u.includes("/api/challenges/detail") ? { ok: true, detail: { ...acm, testCode: "", ioCases: [{ input: "1", expected: "1" }] } }
        : u.includes("/api/challenges?") ? { ok: true, total: 1, done: 0, left: 1, list: [acm] }
          : base;
      return { ok: true, status: 200, json: async () => j };
    };
  });
  await page.goto(pathToFileURL(PANEL).href, { waitUntil: "load" });
  await page.waitForTimeout(700);
  return { browser, page };
}

test("面试手写轮：CodeMirror 必须撑满宿主（不得被 flex 压成窄条）", async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  const { browser, page } = ctx;
  try {
    await page.evaluate(() => { (/** @type {any} */ (window)).switchTab?.("interview"); });
    await page.waitForTimeout(800);
    await page.evaluate(() => /** @type {any} */ (document.getElementById("iv-start"))?.click());
    await page.waitForTimeout(2200);
    const g = await page.evaluate(() => {
      const rect = (s) => { const el = document.querySelector(s); const b = el?.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; };
      const host = document.getElementById("iv-editor");
      return { cm: rect("#iv-editor .cm-editor"), host: host ? { w: Math.round(host.getBoundingClientRect().width), h: Math.round(host.getBoundingClientRect().height) } : null };
    });
    assert.ok(g.cm, "代码轮应挂出 CodeMirror（.cm-editor）");
    assert.ok(g.host, "宿主 #iv-editor 存在");
    assert.ok(g.cm.w >= g.host.w - 8, `CM 宽度应撑满宿主（实测 CM ${g.cm.w}px vs 宿主 ${g.host.w}px）——被压窄说明 flex 布局把它收缩了`);
    assert.ok(g.cm.h >= 100, `CM 高度应可见（实测 ${g.cm.h}px）`);
  } finally { await browser.close(); }
});

test("专项练习：CodeMirror 同样撑满做题区宿主", async (t) => {
  const ctx = await openPanel(t);
  if (!ctx) return;
  const { browser, page } = ctx;
  try {
    await page.evaluate(() => { (/** @type {any} */ (window)).switchTab?.("practice"); });
    await page.waitForTimeout(800);
    await page.evaluate(() => /** @type {any} */ (document.querySelector(".ch-practice"))?.click());
    await page.waitForTimeout(2000);
    const g = await page.evaluate(() => {
      const cm = document.querySelector(".ch-editor .cm-editor");
      const host = document.querySelector(".ch-editor .ch-code-host");
      const b1 = cm?.getBoundingClientRect(), b2 = host?.getBoundingClientRect();
      return { cm: b1 ? Math.round(b1.width) : 0, host: b2 ? Math.round(b2.width) : 0 };
    });
    assert.ok(g.cm > 0, "做题区应挂出 CodeMirror");
    assert.ok(g.cm >= g.host - 8, `CM 宽度应撑满做题区（实测 CM ${g.cm}px vs 宿主 ${g.host}px）`);
  } finally { await browser.close(); }
});
