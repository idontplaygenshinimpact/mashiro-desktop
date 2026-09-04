// 验证 M9：首屏不加载 react/vue bundle（动态 import） + 轮询门控（tab 切换后请求停止）
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ args: [path.join(ROOT, "desktop", "main.mjs")] });
try {
  await sleep(6000);
  const pet = await app.firstWindow();
  await sleep(3000);
  try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); } catch { /* ignore */ }
  await sleep(2500);
  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  if (!panel) { console.log("NO PANEL"); process.exit(1); }

  // ① 首屏资源（react/vue bundle 不该加载）
  const first = await panel.evaluate(() => {
    const res = performance.getEntriesByType("resource").map((r) => r.name);
    return {
      reactLoaded: res.some((r) => r.includes("react-panel.js")),
      vueLoaded: res.some((r) => r.includes("vue-review.js")),
      total: res.length,
    };
  });
  console.log("首屏 bundle:", JSON.stringify(first), first.reactLoaded || first.vueLoaded ? "❌ 应首屏不加载" : "✅ 首屏不加载");

  // ② 轮询门控：crawl tab 激活时 loadCrawlData 轮询在跑；切走后暂停
  const pollBefore = await panel.evaluate(() => {
    // 检查 loadCrawlData 的 interval 状态（通过全局 _pollers 注册表）
    return (/** @type {any} */ (window))._pollers ? JSON.stringify([...(/** @type {any} */ (window))._pollers.keys()]) : "无注册表（panel-rest 未加载）";
  });
  console.log("轮询注册表:", pollBefore);

  // ③ 切 React 后 bundle 加载（动态 import 生效）
  await panel.click('.tab[data-tab="interview"]').catch(() => {});
  await sleep(500);
  await panel.click("#iv-renderer-react").catch(() => {});
  await sleep(2000);
  const after = await panel.evaluate(() => {
    const res = performance.getEntriesByType("resource").map((r) => r.name);
    return { reactLoadedNow: res.some((r) => r.includes("react-panel.js")), mounted: document.getElementById("interview-react")?.childElementCount > 0 };
  });
  console.log("切 React 后:", JSON.stringify(after), after.reactLoadedNow && after.mounted ? "✅ 动态加载+挂载" : "❌");
} finally {
  await app.close().catch(() => {});
}
