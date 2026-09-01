// 检查 Vue 复习卡样式是否生效（css 引入后）
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
  await panel.click('.tab[data-tab="review"]').catch(() => {});
  await sleep(500);
  await panel.click("#rv-renderer-vue").catch(() => {});
  await sleep(2500);
  const style = await panel.evaluate(() => {
    const cont = document.getElementById("review-vue");
    const cs = getComputedStyle(cont);
    const rc = cont.querySelector(".rc-card");
    const rcs = rc ? getComputedStyle(rc) : null;
    const rcb = rcs ? getComputedStyle(rc.querySelector(".rc-back") || rc) : null;
    const face = rc ? rc.querySelector(".rc-face") : null;
    const faceBg = face ? getComputedStyle(face).backgroundImage.slice(0, 70) : "none";
    return {
      containerBg: cs.backgroundImage.slice(0, 60),
      containerRadius: cs.borderRadius,
      cardBg: faceBg,
      cardText: rc?.textContent?.slice(0, 30) || "",
      curveSvg: cont.querySelectorAll("svg").length,
      curveTexts: cont.querySelectorAll("svg text").length,
      svgX: cont.querySelector("svg text:last-of-type") ? cont.querySelector("svg text:last-of-type").getAttribute("x") : "none",
    };
  });
  console.log("Vue 样式:", JSON.stringify(style));
} finally {
  await app.close().catch(() => {});
}
