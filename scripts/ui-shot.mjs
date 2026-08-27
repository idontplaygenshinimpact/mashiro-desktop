// UI 截图基线工具：启动桌宠 → 打开面板 → 逐 tab 截图（供视觉回归/审查）
// 用法：node scripts/ui-shot.mjs [--dir ui-shots]
// 前置：widget 服务在跑（面板数据完整）；没跑也能截（empty 态）
import { _electron } from "playwright";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const MAIN = path.join(ROOT, "desktop", "main.mjs");
const OUT = path.join(ROOT, process.argv[2] === "--dir" && process.argv[3] ? process.argv[3] : "ui-shots");
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);

const app = await _electron.launch({ args: [MAIN] });
try {
  const pet = await app.firstWindow();
  await sleep(4000);
  // 打开面板
  try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); } catch { console.log("togglePanel 调用失败，尝试继续"); }
  await sleep(2500);

  // 找面板窗口（url 含 panel.html）
  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  if (!panel) { console.log("❌ 未找到面板窗口，现有窗口:", app.windows().map((w) => { try { return w.url(); } catch { return "?"; } })); process.exit(1); }

  const tabs = await panel.evaluate(() =>
    [...document.querySelectorAll(".tab[data-tab]")].map((t) => t.getAttribute("data-tab"))
  );
  console.log("发现 tab:", tabs.join(", "));

  // 整窗截图（面板全貌）
  await panel.screenshot({ path: path.join(OUT, `panel-full-${ts}.png`) });
  console.log("✅ panel-full");

  // 逐 tab 截图
  for (const tab of tabs) {
    try {
      await panel.click(`.tab[data-tab="${tab}"]`);
      await sleep(1200);
      await panel.screenshot({ path: path.join(OUT, `tab-${tab}-${ts}.png`) });
      console.log(`✅ tab-${tab}`);
    } catch (e) {
      console.log(`❌ tab-${tab}: ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`截图目录: ${OUT}`);
} finally {
  await app.close().catch(() => {});
}

