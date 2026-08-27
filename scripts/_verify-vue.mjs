// 验证：tab-review 恢复原生独占（无 Vue 叠加）
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ args: [path.join(ROOT, "desktop", "main.mjs")] });
try {
  const pet = await app.firstWindow();
  await sleep(4000);
  try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); } catch { /* ignore */ }
  await sleep(2500);
  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  if (!panel) { console.log("NO PANEL"); process.exit(1); }
  await panel.click('.tab[data-tab="review"]').catch(() => {});
  await sleep(1500);
  const r = await panel.evaluate(() => {
    const root = document.getElementById("vue-review-root");
    return {
      vueRootRemoved: !root,
      nativeReview: document.querySelector("#tab-review .review-stats") || document.querySelector("#tab-review .study-item") ? "有原生内容" : "原生内容待确认",
      tabText: document.getElementById("tab-review")?.textContent.replace(/\s+/g, " ").slice(0, 80) || "EMPTY",
    };
  });
  console.log("tab-review:", JSON.stringify(r));
} finally {
  await app.close().catch(() => {});
}

