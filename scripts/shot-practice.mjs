// UI 效果检查（本次改动面）：专项练习三态 × 核心代码/ACM 模式、ACM 做题编辑器与用例面板、判题逐用例 diff、
// 录入笔试题浮层、清单条目（笔试题徽标 + 去做题）、面试手写轮 CodeMirror。
// 用途：**人眼/视觉模型复核**——jsdom 只能证明 DOM 结构，证明不了"看起来对不对"（布局溢出/遮挡/字号/对比度）。
// 做法同 scripts/shot-panel.mjs：playwright-core 真 Chromium + file:// 打开 panel.html + 注入 mock IPC/fetch。
// 不启动 Electron、不连运行中的 widget、不写数据库（纯前端渲染）。
// 用法：node scripts/shot-practice.mjs [输出目录]
import { chromium } from "playwright-core";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "output", "ui-practice"));
const PANEL = path.join(ROOT, "desktop", "renderer", "panel.html");
if (!existsSync(PANEL)) { console.error("panel.html 不存在"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const ACM_ITEM = {
  id: "acm-prefix-sum", title: "区间和（多组询问）", category: "algorithm", difficulty: 2, frequency: 2,
  timeLimit: 10, mode: "acm", done: false, wrongCount: 1,
  description: "输入格式：第一行 n 与 q，第二行 n 个整数，随后 q 行每行 l r。\n输出格式：q 行，每行区间和。",
  skeleton: "// ACM 模式：自己读输入、自己输出（readline() 逐行读，耗尽返回 null；print() 输出）\n",
};
const CORE_ITEM = {
  id: "debounce", title: "手写防抖 debounce", category: "handwrite", difficulty: 1, frequency: 3,
  timeLimit: 10, mode: "core", done: false, wrongCount: 0,
  description: "补全 debounce 函数：快速连续调用只执行最后一次。", skeleton: "function debounce(fn, delay = 300) {\n  // 在这里写你的实现\n}\n",
};
const IO_CASES = [
  { input: "5 2\n1 2 3 4 5\n1 3\n2 5", expected: "6\n14" },
  { input: "3 1\n10 20 30\n3 3", expected: "30" },
];
const PLAN = {
  date: "2026-09-16",
  items: [
    { id: "p1", topic: "笔试题·区间和（多组询问）", why: "ACM 模式笔试题（自己读输入/自己输出）——练「读入解析 + 输出格式 + 多组/EOF」", source: "题库", level: "必会", grp: "算法与手写", done: false, hasFile: false, mode: "acm", challengeId: "acm-prefix-sum" },
    { id: "p2", topic: "手写题·防抖 debounce", why: "题库练习题目", source: "题库", level: "进阶", grp: "算法与手写", done: false, hasFile: true, mode: "core", challengeId: "debounce" },
    { id: "p3", topic: "事件循环与微任务", why: "面经高频考点", level: "必会", grp: "JavaScript 核心", done: false, hasFile: false },
  ],
};

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + String(e.message).slice(0, 160)));

await page.addInitScript(({ ACM_ITEM, CORE_ITEM, IO_CASES, PLAN }) => {
  const base = { ok: true, base: "http://127.0.0.1:8899", plan: PLAN, files: [], progress: { status: "idle", message: "暂无爬取任务" }, stats: {}, review: { total: 0 } };
  const stubs = {
    getData: base,
    studyPlan: { ok: true, plan: PLAN },
    invStart: { ok: true, session: { round: 1, roundType: "手写轮" }, question: "手写一个防抖函数，并说明边界", answerMode: "code", dimension: "代码能力", criteria: "c", boundary: "b" },
    invStatus: { ok: true, active: false },
    reviewDue: { ok: true, due: [] },
    patrolConfig: { ok: true, enabled: false, intervalMin: 60 },
  };
  const W = /** @type {any} */ (window);
  W.kanban = new Proxy({}, { get: (_t, prop) => async () => (stubs[prop] ?? base) });
  W.fetch = async (url) => {
    const u = String(url);
    let j = { ok: false };
    if (u.includes("/api/challenges/detail")) j = { ok: true, detail: { ...ACM_ITEM, testCode: "", ioCases: IO_CASES } };
    else if (u.includes("/api/challenges/run")) j = {
      // 判题失败：带逐用例 diff（ACM 口径）
      ok: true, success: false, durationMs: 18, error: null, logs: ["[log] 读入 3 行"],
      tests: [
        { passed: true, label: "用例 1" },
        { passed: false, label: "用例 2", input: "3 1\n10 20 30\n3 3", expected: "30", actual: "0" },
      ],
      reflow: { wrong: true, title: ACM_ITEM.title },
    };
    else if (u.includes("/api/challenges?")) {
      const mode = new URL(u, "http://x").searchParams.get("mode") || "core";
      const list = mode === "acm" ? [ACM_ITEM] : [CORE_ITEM];
      j = { ok: true, total: list.length, done: 0, left: list.length, list };
    } else if (u.includes("/api/study-plan")) j = { ok: true, plan: PLAN };
    else if (u.includes("/api/oj/problems")) j = { ok: true, total: 0, problems: [], byCategory: [] };
    else if (u.includes("/api/oj/progress")) j = { ok: true, list: [], total: 0 };
    return { ok: true, json: async () => j, status: 200 };
  };
}, { ACM_ITEM, CORE_ITEM, IO_CASES, PLAN });

await page.goto("file:///" + PANEL.replace(/\\/g, "/"), { waitUntil: "load" });
await page.waitForTimeout(700);

const shots = [];
async function shoot(name, sel) {
  const file = path.join(OUT, `${name}.png`);
  const diag = await page.evaluate((s) => ({
    chItems: document.querySelectorAll("#challenge-list .job-item").length,
    chPracticeBtns: document.querySelectorAll(".ch-practice").length,
    editors: document.querySelectorAll(".ch-editor").length,
    visible: s ? !!(document.querySelector(s) && document.querySelector(s).getBoundingClientRect().height > 0) : true,
  }), sel || null);
  let note = null;
  try {
    const el = sel ? await page.$(sel) : null;
    if (el && diag.visible) await el.screenshot({ path: file, timeout: 3000 });
    else { await page.screenshot({ path: file }); note = `元素不可见，退化为整页（${sel}）`; }
  } catch (e) {
    await page.screenshot({ path: file });
    note = `元素截图失败，退化为整页：${String(e.message).slice(0, 80)}`;
  }
  const audit = await page.evaluate((s) => {
    const root = s && document.querySelector(s) ? document.querySelector(s) : document.body;
    const all = [...root.querySelectorAll("*")];
    const clickable = all.filter((e) => ["BUTTON", "A", "INPUT", "SELECT"].includes(e.tagName));
    // WCAG 对比度（不依赖视觉模型也能量化"看不清"）：向上找第一个不透明背景
    const lum = (rgb) => {
      const m = String(rgb).match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?/);
      if (!m) return null;
      const a = m[4] === undefined ? 1 : Number(m[4]);
      if (a === 0) return null;
      const f = (v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
      return { L: 0.2126 * f(m[1]) + 0.7152 * f(m[2]) + 0.0722 * f(m[3]), a };
    };
    const bgOf = (el) => { let n = el; while (n) { const b = lum(getComputedStyle(n).backgroundColor); if (b && b.a > 0.5) return b.L; n = n.parentElement; } return 1; };
    let lowContrast = 0, smallTarget = 0;
    for (const e of all) {
      // 渐变/图片背景（background-image）没法用 background-color 判对比度（白字在紫色渐变上是合格的）→ 跳过，避免假阳性
      const cs0 = getComputedStyle(e);
      if (cs0.backgroundImage && cs0.backgroundImage !== "none") continue;
      if (!e.children.length && (e.textContent || "").trim()) {
        const cs = getComputedStyle(e);
        if (cs.visibility === "hidden" || cs.display === "none") continue;
        const fg = lum(cs.color);
        if (!fg) continue;
        const L1 = Math.max(fg.L, bgOf(e)), L2 = Math.min(fg.L, bgOf(e));
        const ratio = (L1 + 0.05) / (L2 + 0.05);
        const px = parseFloat(cs.fontSize);
        const large = px >= 18 || (px >= 14 && Number(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) lowContrast++;
      }
    }
    for (const e of clickable) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && (r.width < 22 || r.height < 22)) smallTarget++;
    }
    return {
      els: all.length,
      tinyText: all.filter((e) => e.tagName !== "SUP" && !e.children.length && (e.textContent || "").trim() && parseFloat(getComputedStyle(e).fontSize) < 11).length,
      overflowX: all.filter((e) => e.scrollWidth > e.clientWidth + 2 && !["auto", "scroll"].includes(getComputedStyle(e).overflowX)).length,
      noLabel: clickable.filter((e) => !e.getAttribute("aria-label") && !e.getAttribute("title") && !(e.textContent || "").trim()).length,
      lowContrast, smallTarget,
    };
  }, sel || null);
  shots.push({ name, audit, note, diag });
  console.log(`✅ ${name}${note ? " ⚠ " + note : ""} 诊断=${JSON.stringify(diag)}`);
}
const go = (tab, mode) => page.evaluate(([t, m]) => {
  const W = /** @type {any} */ (window);
  W.switchTab?.(t);
  if (m) W.switchRenderer?.(t, m);
}, [tab, mode]);

// 1) 专项练习：原生 核心代码 / ACM
await go("practice", "native"); await page.waitForTimeout(700);
await shoot("01-practice-native-core", "#tab-practice");
await page.evaluate(() => /** @type {any} */ (document.querySelector('#challenge-cats .oj-cat-chip[data-mode="acm"]'))?.click());
await page.waitForTimeout(700);
await shoot("02-practice-native-acm", "#tab-practice");

// 2) ACM 做题：展开编辑器（CodeMirror 按需注入）+ 用例面板
await page.evaluate(() => /** @type {any} */ (document.querySelector(".ch-practice"))?.click());
await page.waitForTimeout(1500); // 等 code mirror 产物注入
await shoot("03-acm-editor-and-cases", ".ch-editor");

// 3) 判题失败 → 逐用例 diff
await page.evaluate(() => /** @type {any} */ (document.querySelector(".ch-editor-run"))?.click());
await page.waitForTimeout(600);
await shoot("04-acm-run-diff", ".ch-editor");

// 4) 录入笔试题浮层（多行）
await page.evaluate(() => {
  const W = /** @type {any} */ (window);
  W.__askText?.({ title: "➕ 录入 ACM 笔试题", label: "把题面整段粘进来（含输入格式/输出格式/样例输入/样例输出/数据范围）", placeholder: "题目描述…\n输入格式：…\n样例输入：…\n样例输出：…", multiline: true, rows: 16, width: 720 });
});
await page.waitForTimeout(400);
await shoot("05-import-modal", ".sd-overlay:not(.hidden)");
// 关掉浮层——**视觉复核实测踩到**：不关的话后续 06~09 全被中央白弹窗遮住，截图等于废片
// （当时视觉模型报"中央巨大白色弹窗遮挡主要內容"，才发现是我截图脚本的问题）
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
console.log(`   浮层关闭检查：仍显示的 ask 浮层 = ${await page.evaluate(() => [...document.querySelectorAll(".sd-modal-ask")].filter((e) => (e.closest(".sd-overlay")?.getBoundingClientRect().height || 0) > 0).length)}（应为 0）`);

// 5) 清单：笔试题徽标 + 去做题
await page.evaluate(() => (/** @type {any} */ (window)).loadStudyPlan?.());
await go("study", "native"); await page.waitForTimeout(900);
await shoot("06-study-plan-native", "#tab-study");

// 6) 面试手写轮（CodeMirror）：先切 Tab 等它加载完，再点开始
await go("interview", "native"); await page.waitForTimeout(900);
const ivStub = await page.evaluate(() => typeof (/** @type {any} */ (window)).kanban?.invStart);
await page.evaluate(() => /** @type {any} */ (document.getElementById("iv-start"))?.click());
await page.waitForTimeout(2000);
const ivState = await page.evaluate(() => ({
  cm: !!document.querySelector("#iv-editor .cm-editor"),
  answerHidden: document.getElementById("iv-answer")?.style.display === "none",
  round: (document.getElementById("iv-question")?.textContent || "").slice(0, 30),
}));
console.log(`   面试手写轮状态：${JSON.stringify(ivState)}（invStart 桥类型 ${ivStub}）`);
await shoot("07-interview-code-round", "#tab-interview");

// 7) React / Vue 版专项练习（ACM 模式）
await go("practice", "react"); await page.waitForTimeout(2200);
await page.evaluate(() => { const b = [...document.querySelectorAll("#practice-react .rf-btn")].find((x) => /ACM/.test(x.textContent || "")); /** @type {any} */ (b)?.click(); });
await page.waitForTimeout(900);
await shoot("08-practice-react", "#practice-react");
await go("practice", "vue"); await page.waitForTimeout(2200);
await page.evaluate(() => { const b = [...document.querySelectorAll("#practice-vue .rf-btn")].find((x) => /ACM/.test(x.textContent || "")); /** @type {any} */ (b)?.click(); });
await page.waitForTimeout(900);
await shoot("09-practice-vue", "#practice-vue");

console.log("\n=== 审计指标（越小越好）===");
for (const s of shots) console.log(`${s.name}: ${JSON.stringify(s.audit)}`);
console.log("\n=== 控制台错误 ===");
console.log(consoleErrors.length ? consoleErrors.join("\n") : "（无）");
console.log(`\n输出目录: ${OUT}`);
await browser.close();
