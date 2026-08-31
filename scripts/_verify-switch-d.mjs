// 验证方案 D 同窗切换（逐步日志版）
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("[1] launch...");
const app = await _electron.launch({ args: [path.join(ROOT, "desktop", "main.mjs")] });
console.log("[2] launched");
try {
  await sleep(6000);
  console.log("[3] windows:", app.windows().length);
  const pet = await app.firstWindow();
  console.log("[4] pet:", pet.url());
  await sleep(3000);
  try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); console.log("[5] togglePanel ok"); } catch (e) { console.log("[5] togglePanel err:", e.message); }
  await sleep(2500);
  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  console.log("[6] panel found:", !!panel);
  if (!panel) process.exit(1);

  await panel.click('.tab[data-tab="interview"]').catch((e) => console.log("[7] tab click err:", e.message));
  await sleep(500);
  console.log("[8] 按钮存在:", await panel.evaluate(() => !!document.getElementById("iv-renderer-react")));
  await panel.click("#iv-renderer-react").catch((e) => console.log("[9] react btn err:", e.message));
  await sleep(2500);
  const r1 = await panel.evaluate(() => {
    const native = document.getElementById("interview-native");
    const react = document.getElementById("interview-react");
    return {
      nativeHidden: native?.style.display === "none",
      reactShown: react?.style.display !== "none",
      reactChildren: react?.childElementCount ?? -1,
      reactText: (react?.textContent || "").replace(/\s+/g, " ").slice(0, 50),
    };
  });
  console.log("[10] 面试→React:", JSON.stringify(r1));

  await panel.click("#iv-renderer-switch").catch(() => {});
  await sleep(800);
  const r2 = await panel.evaluate(() => {
    const react = document.getElementById("interview-react");
    return { reactHidden: react?.style.display === "none", reactChildren: react?.childElementCount ?? -1 };
  });
  console.log("[11] 面试→原生:", JSON.stringify(r2));

  await panel.click('.tab[data-tab="review"]').catch(() => {});
  await sleep(500);
  await panel.click("#rv-renderer-vue").catch((e) => console.log("[12] vue btn err:", e.message));
  await sleep(2500);
  const r3 = await panel.evaluate(() => {
    const vue = document.getElementById("review-vue");
    return { vueShown: vue?.style.display !== "none", vueChildren: vue?.childElementCount ?? -1, vueText: (vue?.textContent || "").replace(/\s+/g, " ").slice(0, 50) };
  });
  console.log("[13] 复习→Vue:", JSON.stringify(r3));

  await panel.click("#rv-renderer-switch").catch(() => {});
  await sleep(800);
  const r4 = await panel.evaluate(() => {
    const vue = document.getElementById("review-vue");
    return { vueHidden: vue?.style.display === "none", vueChildren: vue?.childElementCount ?? -1 };
  });
  console.log("[14] 复习→原生:", JSON.stringify(r4));
} finally {
  await app.close().catch(() => {});
  console.log("[15] closed");
}
