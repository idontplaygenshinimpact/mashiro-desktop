// UI 排查：Vue 复习卡（同窗内嵌）/ React 面试（同窗内嵌）——截图 + 布局检查 + 控制台错误
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = await _electron.launch({ args: [path.join(ROOT, "desktop", "main.mjs")] });
const errors = [];
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
  panel.on("pageerror", (e) => errors.push("pageerror: " + String(e.message || e).slice(0, 150)));
  panel.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text().slice(0, 150)); });

  // ① React 视图（面试 Tab 切 React）
  await panel.click('.tab[data-tab="interview"]').catch(() => {});
  await sleep(500);
  await panel.click("#iv-renderer-react").catch((e) => console.log("react btn err:", e.message));
  await sleep(2500);
  await panel.screenshot({ path: path.join(ROOT, "ui-shots", "react-view.png") });
  const reactLayout = await panel.evaluate(() => {
    const issues = [];
    for (const el of document.querySelectorAll("#interview-react *")) {
      if (el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX !== "hidden" && cs.overflowX !== "auto") {
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += "#" + el.id;
          else if (el.className && typeof el.className === "string") sel += "." + String(el.className).trim().split(/\s+/)[0];
          issues.push(`h-overflow ${sel} (${el.scrollWidth}/${el.clientWidth})`);
        }
      }
    }
    const react = document.getElementById("interview-react");
    return { mounted: react?.childElementCount > 0, textLen: react?.textContent?.length || 0, issues: issues.slice(0, 5) };
  });
  console.log("React 视图:", JSON.stringify(reactLayout));

  // ② Vue 视图（复习 Tab 切 Vue）
  await panel.click('.tab[data-tab="review"]').catch(() => {});
  await sleep(500);
  await panel.click("#rv-renderer-vue").catch((e) => console.log("vue btn err:", e.message));
  await sleep(2500);
  await panel.screenshot({ path: path.join(ROOT, "ui-shots", "vue-view.png") });
  const vueLayout = await panel.evaluate(() => {
    const issues = [];
    for (const el of document.querySelectorAll("#review-vue *")) {
      if (el.scrollWidth > el.clientWidth + 3 && el.clientWidth > 0) {
        const cs = getComputedStyle(el);
        if (cs.overflowX !== "hidden" && cs.overflowX !== "auto") {
          let sel = el.tagName.toLowerCase();
          if (el.id) sel += "#" + el.id;
          else if (el.className && typeof el.className === "string") sel += "." + String(el.className).trim().split(/\s+/)[0];
          issues.push(`h-overflow ${sel} (${el.scrollWidth}/${el.clientWidth})`);
        }
      }
    }
    const vue = document.getElementById("review-vue");
    return { mounted: vue?.childElementCount > 0, textLen: vue?.textContent?.length || 0, issues: issues.slice(0, 5) };
  });
  console.log("Vue 视图:", JSON.stringify(vueLayout));
  console.log("错误:", errors.length ? errors.join("\n") : "无");
  console.log("截图: ui-shots/react-view.png / ui-shots/vue-view.png");
} finally {
  await app.close().catch(() => {});
}
