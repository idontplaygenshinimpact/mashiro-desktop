// 像素级对比度审计：对**真渲染**的截图逐文字行采样，量化"文字到底看不看得清"。
// 为什么不能用 computed style：壁纸/渐变/半透明底板都会让"背景色"不等于实际看到的底色——
// 只能按像素测。本轮据此定位并修掉了"正文直接压在动漫壁纸上"（103 个文字元素 46 个低于 WCAG AA），
// 加 `.tab-panel.active` 半透明底板后降到 1/136。
// 方法：真 Chromium 打开 panel.html（file:// + mock 桥，不启 Electron、不连运行中的 widget、不写库）
//   → 截整页 PNG → 页面内 canvas 解码 → 对每个文字行（Range.getClientRects 紧贴矩形）采样：
//   · 背景 = 矩形**外环 6px** 的亮度众数（不受字形占比影响）
//   · 字色 = 矩形内背离背景方向的 2% 分位极值
//   · 对比度 = (Lmax+0.05)/(Lmin+0.05)，阈值 WCAG AA：正文 4.5 / 大字 3.0
// 用法：node scripts/ui-contrast-pixels.mjs [阈值=4.5]
// 注意：小号 chip（字形占比过半）上的单项数值偏噪声，看**各屏合计与中位数**更可靠。
import { chromium } from "playwright-core";
import path from "node:path";

const THRESHOLD = Number(process.argv[2]) || 4.5;
const ROOT = path.join(import.meta.dirname, "..");
const PANEL = path.join(ROOT, "desktop", "renderer", "panel.html");
const CASES = [
  ["dashboard", "native"], ["kb", "native"], ["study", "native"], ["crawl", "native"],
  ["interview", "native"], ["review", "native"], ["jobs", "native"], ["practice", "native"], ["chat", "native"],
  ["review", "vue"], ["dashboard", "vue"], ["practice", "react"], ["practice", "vue"], ["study", "react"],
];

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
await page.addInitScript(() => {
  const plan = { date: "2026-09-16", items: [{ id: "p1", topic: "事件循环与微任务", why: "面经高频考点，建议优先补强", level: "必会", grp: "JavaScript 核心", done: false }] };
  const base = {
    ok: true, base: "http://127.0.0.1:8899", plan, files: [{ company: "字节跳动", title: "前端一面面经", dir: "output/2026-09-01" }],
    progress: { status: "idle", message: "暂无爬取任务", plan: { done: 1, total: 2 }, challenges: { done: 0, total: 1 }, review: { mastered: 0, total: 1, due: 0 }, jobs: { open: 0, applied: 0 } },
    week: { studyDone: 1, reviewDone: 0, challengeDone: 0, focusMinutes: 0, applyCount: 0, interviewCount: 0 }, weekSeries: [],
    stats: { chats: 1, reviewsDone: 0, interviewsDone: 0 }, review: { total: 1 }, hits: [], history: [], weak: [], mastery: [], trend: [], total: 1,
    list: [], items: [], docs: 1, followups: 0, date: "2026-09-16", enabled: true, due: [{ id: "c1", topic: "事件循环与微任务", question: "请解释宏任务与微任务", priority: "必会", type: "concept" }],
  };
  const challenge = { id: "c", title: "手写防抖 debounce", category: "handwrite", difficulty: 1, frequency: 3, mode: "core", done: false, wrongCount: 0, description: "x", skeleton: "" };
  const W = /** @type {any} */ (window);
  W.kanban = new Proxy({}, { get: () => async () => base });
  W.fetch = async (url) => ({ ok: true, status: 200, json: async () => (String(url).includes("/api/challenges?") ? { ok: true, total: 1, done: 0, left: 1, list: [challenge] } : base) });
});
await page.goto("file:///" + PANEL.replace(/\\/g, "/"), { waitUntil: "load" });
await page.waitForTimeout(800);

async function measure(tab, mode) {
  await page.evaluate(([t, m]) => { const W = /** @type {any} */ (window); W.switchTab?.(t); W.switchRenderer?.(t, m); }, [tab, mode]);
  await page.waitForTimeout(mode === "native" ? 700 : 2200);
  const sel = `#${tab}-${mode}`;
  const lines = await page.evaluate((s) => {
    const root = document.querySelector(s);
    if (!root) return [];
    const out = [];
    for (const e of root.querySelectorAll("*")) {
      if (e.children.length) continue;
      const txt = (e.textContent || "").trim();
      if (txt.length < 2) continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const range = document.createRange();
      range.selectNodeContents(e);
      for (const r of range.getClientRects()) {
        if (r.width < 8 || r.height < 7) continue;
        out.push({ text: txt.slice(0, 14), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), px: parseFloat(cs.fontSize) });
        break;
      }
      if (out.length >= 45) break;
    }
    return out;
  }, sel);
  const png = await page.screenshot();
  const res = await page.evaluate(async ({ b64, lines, th }) => {
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.src = "data:image/png;base64," + b64; });
    const cv = document.createElement("canvas"); cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0);
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const out = [];
    for (const L of lines) {
      const x = Math.max(0, L.x), y = Math.max(0, L.y);
      const w = Math.min(L.w, img.width - x), h = Math.min(L.h, img.height - y);
      if (w < 6 || h < 6) continue;
      const d = ctx.getImageData(x, y, w, h).data;
      const lums = [];
      for (let k = 0; k < d.length; k += 4) if (d[k + 3] > 200) lums.push(0.2126 * f(d[k]) + 0.7152 * f(d[k + 1]) + 0.0722 * f(d[k + 2]));
      if (lums.length < 30) continue;
      const rx = Math.max(0, x - 6), ry = Math.max(0, y - 6);
      const rw = Math.min(img.width - rx, w + 12), rh = Math.min(img.height - ry, h + 12);
      const rd = ctx.getImageData(rx, ry, rw, rh).data;
      const ring = new Map();
      for (let k = 0; k < rd.length; k += 4) {
        if (rd[k + 3] < 200) continue;
        const px = (k / 4) % rw, py = Math.floor((k / 4) / rw);
        if (px >= 6 && px < rw - 6 && py >= 6 && py < rh - 6) continue;
        const l = 0.2126 * f(rd[k]) + 0.7152 * f(rd[k + 1]) + 0.0722 * f(rd[k + 2]);
        const key = Math.round(l * 20) / 20;
        ring.set(key, (ring.get(key) || 0) + 1);
      }
      const bg = ring.size ? [...ring.entries()].sort((a, b) => b[1] - a[1])[0][0] : 1;
      lums.sort((a, b) => a - b);
      const dark = lums[Math.floor(lums.length * 0.02)], light = lums[Math.floor(lums.length * 0.98)];
      const ink = Math.abs(light - bg) >= Math.abs(dark - bg) ? light : dark;
      const hi = Math.max(ink, bg), lo = Math.min(ink, bg);
      const ratio = Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      const need = L.px >= 14 ? 3 : th;
      // 纯 emoji/图形样本不计入文字对比度：WCAG 的对比度要求针对**文字**，emoji 是字形图（颜色不受 CSS
      // 控制，如 🔥🔥🔥 实测 3.1、🗑 实测 2.0 都只是字形自带配色）——把它们算进来会产生无法修复的噪声。
      // 只跳过"去掉 emoji/零宽连接符/空白后没有剩余字符"的样本；含文字+emoji（如「🆕 首次」）照常测量。
      const textOnly = L.text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D\s]/gu, "");
      if (!textOnly) continue;
      out.push({ text: L.text, ratio, pass: ratio >= need });
    }
    return out;
  }, { b64: png.toString("base64"), lines, th: THRESHOLD });
  const med = res.length ? res.map((r) => r.ratio).sort((a, b) => a - b)[Math.floor(res.length / 2)] : 0;
  return { n: res.length, fails: res.filter((r) => !r.pass), med };
}

console.log(`像素级对比度审计（阈值 ${THRESHOLD}）\n屏                 不达标/样本  中位   最差`);
let tf = 0, tn = 0;
for (const [tab, mode] of CASES) {
  const r = await measure(tab, mode);
  tf += r.fails.length; tn += r.n;
  const worst = r.fails.slice(0, 3).map((w) => `${w.text}=${w.ratio}`).join(" ");
  console.log(`${(tab + "-" + mode).padEnd(18)} ${String(r.fails.length + "/" + r.n).padEnd(12)} ${String(r.med).padEnd(6)} ${worst}`);
}
console.log(`\n合计不达标 ${tf}/${tn}（${Math.round((tf / Math.max(1, tn)) * 100)}%）`);
await browser.close();