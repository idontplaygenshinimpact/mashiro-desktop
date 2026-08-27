// UI 布局断言审计：启动桌宠 → 面板 → 逐 tab 程序化检查布局问题
// 检查项：①横向溢出 ②nowrap 文字截断 ③tab 内容是否渲染 ④控制台错误
// 用法：node scripts/ui-layout-audit.mjs
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const MAIN = path.join(ROOT, "desktop", "main.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const auditFn = () => {
  const issues = [];
  const pathOf = (el) => {
    const parts = [];
    let n = el, guard = 0;
    while (n && n.nodeType === 1 && guard++ < 6) {
      let sel = n.tagName.toLowerCase();
      if (n.id) sel += "#" + n.id;
      else if (n.className && typeof n.className === "string") sel += "." + n.className.trim().split(/\s+/).slice(0, 2).join(".");
      parts.unshift(sel);
      n = n.parentElement;
    }
    return parts.join(" > ");
  };
  // ① 横向溢出（非滚动/非有意裁剪的容器内容超出）
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollWidth > el.clientWidth + 2) {
      const cs = getComputedStyle(el);
      const clipped = cs.overflowX === "hidden" || cs.overflowX === "auto" || cs.overflowX === "scroll";
      if (!clipped && el.clientWidth > 0) {
        issues.push({ type: "h-overflow", sel: pathOf(el), sw: el.scrollWidth, cw: el.clientWidth });
      }
    }
  }
  // ② nowrap 文字截断（排除 ellipsis 正常裁剪）
  for (const el of document.querySelectorAll("*")) {
    const cs = getComputedStyle(el);
    const hasEllipsis = cs.textOverflow === "ellipsis" && (cs.overflowX === "hidden" || cs.overflowX === "clip");
    if (cs.whiteSpace === "nowrap" && el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0 && el.textContent.trim() && !hasEllipsis) {
      issues.push({ type: "truncate", sel: pathOf(el), sw: el.scrollWidth, cw: el.clientWidth, text: el.textContent.trim().slice(0, 24) });
    }
  }
  // ③ tab 内容是否渲染（激活面板非空）
  const active = document.querySelector(".tab-panel.active");
  const content = active ? active.textContent.trim().length : -1;
  return { issues, contentLen: content };
};

const app = await _electron.launch({ args: [MAIN] });
const consoleErrors = [];
try {
  const pet = await app.firstWindow();
  for (const p of app.windows()) p.on("pageerror", (e) => consoleErrors.push(String(e.message || e).slice(0, 120)));
  await sleep(4000);
  try { await pet.evaluate(() => (/** @type {any} */ (window)).kanban.togglePanel()); } catch { /* ignore */ }
  await sleep(2500);

  let panel = null;
  for (const w of app.windows()) {
    try { if (w.url().includes("panel.html")) { panel = w; break; } } catch { /* ignore */ }
  }
  if (!panel) { console.log("❌ 未找到面板窗口"); process.exit(1); }

  const tabs = await panel.evaluate(() =>
    [...document.querySelectorAll(".tab[data-tab]")].map((t) => t.getAttribute("data-tab"))
  );
  console.log(`tab: ${tabs.join(", ")}`);

  for (const tab of tabs) {
    try {
      await panel.click(`.tab[data-tab="${tab}"]`);
      await sleep(1000);
      const r = await panel.evaluate(auditFn);
      const byType = {};
      for (const i of r.issues) byType[i.type] = (byType[i.type] || 0) + 1;
      console.log(`[${tab}] 内容长度=${r.contentLen} 问题: ${Object.keys(byType).map((k) => `${k}=${byType[k]}`).join(" ") || "无"}`);
      if (r.issues.length) {
        for (const i of r.issues.slice(0, 6)) console.log(`    ${i.type}: ${i.sel} (sw=${i.sw}/cw=${i.cw}${i.text ? ` 「${i.text}」` : ""})`);
        if (r.issues.length > 6) console.log(`    …共 ${r.issues.length} 条`);
      }
    } catch (e) {
      console.log(`[${tab}] ❌ ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`\n控制台错误: ${consoleErrors.length ? consoleErrors.join(" | ") : "无"}`);
} finally {
  await app.close().catch(() => {});
}

