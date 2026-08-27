// DPI 矩阵截图：不同显示缩放下的面板布局检查（125%/150%）
// 用法：node scripts/ui-dpi-shot.mjs [--scale 1.25] [--scale 1.5]
import { _electron } from "playwright";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const MAIN = path.join(ROOT, "desktop", "main.mjs");
const OUT = path.join(ROOT, "ui-shots");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scales = [];
const argv = process.argv;
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === "--scale") scales.push(parseFloat(argv[i + 1]));
}
if (!scales.length) scales.push(1.25, 1.5);

for (const scale of scales) {
  console.log(`\n=== DPI ${scale}x ===`);
  const app = await _electron.launch({
    args: [MAIN, `--force-device-scale-factor=${scale}`],
  });
  try {
    const pet = await app.firstWindow();
    await sleep(4000);
    try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); } catch { /* ignore */ }
    await sleep(2500);
    let panel = null;
    for (const w of app.windows()) {
      try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
    }
    if (!panel) { console.log("❌ 未找到面板窗口"); continue; }

    // 布局检查：溢出（在缩放下的表现）
    const audit = await panel.evaluate(() => {
      const issues = [];
      for (const el of document.querySelectorAll("body *")) {
        if (el.scrollWidth > el.clientWidth + 2) {
          const cs = getComputedStyle(el);
          if (cs.overflowX !== "hidden" && cs.overflowX !== "auto" && cs.overflowX !== "scroll" && el.clientWidth > 0) {
            let sel = el.tagName.toLowerCase();
            if (el.id) sel += "#" + el.id;
            issues.push(sel);
          }
        }
      }
      return { issues: issues.slice(0, 8), viewport: [window.innerWidth, window.innerHeight] };
    });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    await panel.screenshot({ path: path.join(OUT, `dpi-${scale}-study-${ts}.png`) });
    await panel.click('.tab[data-tab="dashboard"]').catch(() => {});
    await sleep(800);
    await panel.screenshot({ path: path.join(OUT, `dpi-${scale}-dashboard-${ts}.png`) });
    console.log(`视口 ${audit.viewport.join("x")} | 溢出: ${audit.issues.length ? audit.issues.join(", ") : "无"}`);
    console.log(`截图: dpi-${scale}-study/dashboard`);
  } finally {
    await app.close().catch(() => {});
  }
}
console.log("\nDPI 矩阵完成");

