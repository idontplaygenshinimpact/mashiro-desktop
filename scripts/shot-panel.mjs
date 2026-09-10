// UI 截图 + 审计（前端 UI 批量优化：优先新增界面）
// 为什么用真实 Chromium 而不是 jsdom：jsdom 不渲染像素——布局溢出、字号、对比度、focus 环它都看不见。
// 做法：file:// 打开 panel.html（--allow-file-access-from-files 放行动态 import 框架产物），
// 注入 mock IPC 桥 + mock fetch（与 tests 同款形状），切到各 Tab 的三态渲染层截图，
// 同时打印机器可查的审计指标（内联深色样式数/可点击元素缺 aria/字号过小/横向溢出）。
// 用法：node scripts/shot-panel.mjs [输出目录]
import { chromium } from "playwright-core";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "output", "ui-shots"));
const PANEL = path.join(ROOT, "desktop", "renderer", "panel.html");
const TABS = [
  ["dashboard", "react"], ["kb", "react"], ["study", "react"], ["crawl", "react"],
  ["interview", "react"], ["review", "vue"], ["dashboard", "vue"], ["kb", "vue"], ["study", "vue"], ["crawl", "vue"], ["jobs", "vue"], ["chat", "vue"], ["interview", "vue"],
];

if (!existsSync(PANEL)) { console.error("panel.html 不存在"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });

// mock IPC 桥：任意方法都返回宽松 ok 结果（面板骨架能渲染即可；这里看的是 UI 不是业务数据）
await page.addInitScript(() => {
  const stub = { ok: true, base: "http://127.0.0.1:8899", plan: { date: "2026-09-01", items: [
    { id: "s1", topic: "事件循环与微任务", why: "面经高频考点，建议优先补强", level: "必会", grp: "JavaScript 核心", done: false, hasFile: false },
    { id: "s2", topic: "防抖与节流的手写实现与边界条件", why: "手写题", level: "进阶", grp: "算法与手写", done: false, hasFile: true },
    { id: "s3", topic: "React Hooks 闭包陷阱", why: "项目拷打", level: "必会", grp: "React", done: true, mastered: true, fromInterview: true },
    { id: "s4", topic: "浏览器缓存策略", why: "复习到期", level: "拓展", grp: "浏览器原理", done: true, reviewDue: true } ] },
    items: [], list: [], files: [
      { company: "字节跳动", title: "前端一面面经（含手写题）", dir: "output/2026-09-01" },
      { company: "美团", title: "笔试真题整理", dir: "output/2026-09-01" } ],
    // 同一个 getData 响应被两个 Tab 读：爬取读 progress.status/current/total，驾驶舱读 progress.plan/review/jobs
    progress: { status: "running", message: "正在抓取第 3/10 页", current: 3, total: 10,
      plan: { done: 8, total: 20 }, challenges: { done: 3, total: 15 }, review: { mastered: 12, total: 30, due: 4 },
      direction: "前端", weak: 6, jobs: { open: 7, applied: 4 } },
    week: { studyDone: 5, reviewDone: 12, challengeDone: 3, focusMinutes: 150, applyCount: 4, interviewCount: 2 },
    weekSeries: [1, 2, 3, 4, 5, 6, 0].map((i, n) => ({ date: `2026-09-0${n + 1}`, study: i, review: i + 1, challenge: i % 3, focus: i * 10 })),
    report: { highlights: ["学习闭环不断"], gaps: ["算法题量偏低"], suggestions: ["下周每天 1 道手写题"] },
    stats: { chats: 4, reviewsDone: 7, interviewsDone: 2 }, review: { total: 9 },
    hits: [ { kind: "followup", docId: "事件循环", section: "宏任务与微任务", content: "先同步代码，再清空微任务队列，然后取下一个宏任务。" } ],
    history: [], weak: [], mastery: [], trend: [], total: 12, enabled: true, byKind: [{ kind: "note", n: 7 }], docs: 3, followups: 2, date: "2026-09-01" };
  // 面板通过 preload 注入的 IPC 桥（浏览器里由本脚本注入 mock）——显式声明，不靠 any
  /** @type {{ kanban?: unknown }} */ (/** @type {unknown} */ (window)).kanban = new Proxy({}, { get: () => async () => stub });
  // mock fetch：只实现脚本用到的 ok/json 两个成员——断言成 fetch 类型（真实 Response 更宽，这里是最小实现）
  window.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async (url) => ({ ok: true, json: async () => (String(url).includes("/paragraphs/search") ? { hits: stub.hits, stats: { docs: 3, followups: 2 } } : stub) })));
});

await page.goto("file:///" + PANEL.replace(/\\/g, "/"), { waitUntil: "load" });
await page.waitForTimeout(600);

const report = [];
for (const [tab, mode] of TABS) {
  try {
    await page.evaluate(([t, m]) => { const w = /** @type {{ switchTab?: (tab: string) => void, switchRenderer?: (tab: string, mode: string) => void }} */ (/** @type {unknown} */ (window)); w.switchTab?.(t); w.switchRenderer?.(t, m); }, [tab, mode]);
    await page.waitForTimeout(500);
    const sel = `#${tab}-${mode}`;
    const el = await page.$(sel);
    if (!el) { report.push({ tab, mode, error: `容器缺失 ${sel}` }); continue; }
    const file = path.join(OUT, `${tab}-${mode}.png`);
    await el.screenshot({ path: file });
    // 机器可查的审计：四类问题的量化
    const audit = await page.evaluate((s) => {
      const root = document.querySelector(s);
      if (!root) return null;
      const all = [...root.querySelectorAll("*")];
      const inlineDark = all.filter((e) => { const st = e.getAttribute("style") || ""; return /rgb\(36, 31, 58\)|rgb\(31, 26, 49\)|rgb\(42, 37, 64\)|#241f3a|#1f1a31|#2a2540/.test(st); }).length;
      const clickable = all.filter((e) => e.tagName === "BUTTON" || e.tagName === "A" || e.tagName === "INPUT" || e.tagName === "SELECT");
      const noLabel = clickable.filter((e) => !e.getAttribute("aria-label") && !e.getAttribute("title") && !e.getAttribute("placeholder") && !(e.textContent || "").trim()).length;
      const tinyText = all.filter((e) => e.children.length === 0 && (e.textContent || "").trim() && parseFloat(getComputedStyle(e).fontSize) < 11).length;
      const overflowX = all.filter((e) => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== "auto" && getComputedStyle(e).overflowX !== "scroll").length;
      const noAltImg = all.filter((e) => e.tagName === "IMG" && !e.getAttribute("alt")).length;
      // 视觉一致性度量（UI 批次 2 输入）：字号/文字色/背景色/圆角取值集合——原生 Tab 与框架版做差集
      // 即可量化"两套视觉语言"的缺口（不依赖视觉模型）。每类取出现最多的 8 个值。
      const tally = (get) => {
        const m = new Map();
        for (const e of all) { const v = get(getComputedStyle(e)); if (!v) continue; m.set(v, (m.get(v) || 0) + 1); }
        return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([v, n]) => `${v}×${n}`);
      };
      return {
        nodes: all.length, inlineDarkStyles: inlineDark, clickable: clickable.length,
        clickableWithoutLabel: noLabel, textBelow11px: tinyText, possibleOverflowX: overflowX, imgWithoutAlt: noAltImg,
        scrollH: root.scrollHeight, clientH: root.clientHeight,
        fontSizes: tally((s) => s.fontSize),
        textColors: tally((s) => s.color),
        bgColors: tally((s) => s.backgroundColor).filter((v) => !v.startsWith("rgba(0, 0, 0, 0)")),
        radii: tally((s) => s.borderRadius).filter((v) => v !== "0px"),
      };
    }, sel);
    report.push({ tab, mode, file: path.relative(ROOT, file), ...audit });
  } catch (e) {
    report.push({ tab, mode, error: String(e?.message || e).slice(0, 120) });
  }
}

await browser.close();
console.log(JSON.stringify(report, null, 1));
const bad = report.filter((r) => r.error);
console.log(`\n[shot] ${report.length - bad.length}/${report.length} 张已存到 ${path.relative(ROOT, OUT)}${bad.length ? `；失败 ${bad.length}: ${bad.map((b) => b.tab + "/" + b.mode).join(", ")}` : ""}`);
