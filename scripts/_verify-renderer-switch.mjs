// 验证渲染层切换下拉：选 React → React 窗口；选 Vue → Vue 窗口
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ args: [path.join(ROOT, "desktop", "main.mjs")] });
try {
  await sleep(6000);
  const wins = app.windows().map((w) => { try { return w.url(); } catch { return "?"; } });
  console.log("窗口列表:", wins.join(" | ") || "（空）");
  const pet = await app.firstWindow();
  await sleep(4000);
  try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); } catch { /* ignore */ }
  await sleep(2500);
  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  if (!panel) { console.log("NO PANEL"); process.exit(1); }

  // 下拉存在性
  const hasSwitch = await panel.evaluate(() => !!document.getElementById("renderer-switch"));
  console.log("下拉存在:", hasSwitch);

  // 选 React
  await panel.selectOption("#renderer-switch", "react");
  await sleep(2500);
  let reactWin = null;
  for (const w of app.windows()) {
    try { if ((await w.title()).includes("React")) { reactWin = w; break; } } catch { /* ignore */ }
  }
  console.log("React 窗口:", reactWin ? "✅ 打开" : "❌ 未打开");
  // 下拉应切回原生
  const valAfter = await panel.evaluate(() => /** @type {HTMLSelectElement} */ (document.getElementById("renderer-switch")).value);
  console.log("下拉切回原生:", valAfter === "native" ? "✅" : `❌ (${valAfter})`);

  // 选 Vue
  await panel.selectOption("#renderer-switch", "vue");
  await sleep(2500);
  let vueWin = null;
  for (const w of app.windows()) {
    try { if ((await w.title()).includes("复习卡")) { vueWin = w; break; } } catch { /* ignore */ }
  }
  console.log("Vue 窗口:", vueWin ? "✅ 打开" : "❌ 未打开");
} finally {
  await app.close().catch(() => {});
}

