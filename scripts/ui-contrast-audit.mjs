// UI 对比度审计（WCAG AA）：遍历可见元素，计算文字色 vs 实际背景色对比度
// 背景透明时向上查找父元素背景；标记 < 4.5（正文）/ < 3.0（大字 ≥18px 或 14px bold）
// 用法：node scripts/ui-contrast-audit.mjs
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const MAIN = path.join(ROOT, "desktop", "main.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const auditFn = () => {
  const parse = (s) => {
    const m = String(s || "").match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  };
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const contrast = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const mix = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const bgOf = (el) => {
    // 渐变背景优先：linear-gradient 提取首个色值（getComputedStyle 的 backgroundColor 对渐变是透明）
    const bgImg = getComputedStyle(el).backgroundImage;
    const gm = String(bgImg || "").match(/linear-gradient\([^)]*?,\s*(rgba?\([^)]+\))/);
    if (gm) {
      const c = parse(gm[1]);
      if (c) return c[3] < 0.95 ? mix(c, [255, 255, 255, 1]) : c; // 半透明与白底混合
    }
    let n = el;
    while (n) {
      const cs = getComputedStyle(n);
      const c = parse(cs.backgroundColor);
      if (c && c[3] > 0.05) return c[3] < 0.95 ? mix(c, [255, 255, 255, 1]) : c;
      n = n.parentElement;
    }
    return [255, 255, 255, 1];
  };
  const issues = [];
  const seen = new Set();
  for (const el of document.querySelectorAll("body *")) {
    if (el.children.length) continue; // 只查叶子（文字直接挂的元素）
    // 只查可见元素（隐藏 tab/折叠区会误报）
    const cs0 = getComputedStyle(el);
    if (cs0.display === "none" || cs0.visibility === "hidden") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const cs = cs0;
    const color = parse(cs.color);
    if (!color || color[3] === 0 || !el.textContent.trim()) continue;
    const bg = bgOf(el);
    const size = parseFloat(cs.fontSize) || 13;
    const weight = Number(cs.fontWeight) || 400;
    const isLarge = size >= 18 || (size >= 14 && weight >= 700);
    const ratio = contrast(color, bg);
    const min = isLarge ? 3.0 : 4.5;
    if (ratio < min) {
      const key = cs.color + "|" + (bg.join(",")) + "|" + size;
      if (seen.has(key)) continue;
      seen.add(key);
      let sel = el.tagName.toLowerCase();
      if (el.id) sel += "#" + el.id;
      else if (el.className && typeof el.className === "string") sel += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
      issues.push({ sel, ratio: Math.round(ratio * 100) / 100, color: cs.color, bg: `rgb(${bg.slice(0, 3).join(",")})`, size, weight, text: el.textContent.trim().slice(0, 20) });
    }
  }
  return issues;
};

const app = await _electron.launch({ args: [MAIN] });
try {
  const pet = await app.firstWindow();
  await sleep(4000);
  try { await pet.evaluate(() => window.kanban.togglePanel()); } catch { /* ignore */ }
  await sleep(2500);
  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  if (!panel) { console.log("❌ 未找到面板窗口"); process.exit(1); }

  const tabs = await panel.evaluate(() =>
    [...document.querySelectorAll(".tab[data-tab]")].map((t) => t.getAttribute("data-tab"))
  );
  const all = new Map();
  for (const tab of tabs) {
    try {
      await panel.click(`.tab[data-tab="${tab}"]`);
      await sleep(800);
      const issues = await panel.evaluate(auditFn);
      if (issues.length) {
        all.set(tab, issues);
        console.log(`[${tab}] 对比度不达标 ${issues.length} 条`);
        for (const i of issues.slice(0, 5)) console.log(`    ${i.sel}: ${i.ratio} (${i.color} on ${i.bg}, ${i.size}px w${i.weight}) 「${i.text}」`);
      } else {
        console.log(`[${tab}] ✅ 对比度全达标`);
      }
    } catch (e) {
      console.log(`[${tab}] ❌ ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`\n汇总: ${all.size}/${tabs.length} 个 tab 存在对比度问题`);
} finally {
  await app.close().catch(() => {});
}
