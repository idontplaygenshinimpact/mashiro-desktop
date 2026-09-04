// 验证桌宠快捷菜单 + 手势（Playwright 模拟指针事件）
import { _electron } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), ".."); // 相对推导（换机器可运行）
const app = await _electron.launch({
  executablePath: path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
  args: ["desktop/main.mjs"], cwd: ROOT,
});
try {
  let win = null;
  for (let i = 0; i < 30 && !win; i++) {
    win = app.windows().find((w) => w.url().includes("index.html")) || null;
    if (!win) await new Promise((r) => setTimeout(r, 500));
  }
  if (!win) throw new Error("桌宠窗口未出现");
  const errs = [];
  win.on("console", (msg) => { if (msg.type() === "error") errs.push(msg.text().slice(0, 120)); });
  await win.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 3000));

  const res = await win.evaluate(async () => {
    const out = {};
    // 1) 快捷菜单元素存在
    out.menuExists = !!document.getElementById("quick-menu");
    out.btnCount = document.querySelectorAll(".qm-btn").length;
    // 2) 模拟单击：pointerdown → pointerup（120ms 延迟后菜单显示）
    const canvas = document.getElementById("live2d");
    const rect = canvas.getBoundingClientRect();
    const cx = rect.width / 2, cy = rect.height * 0.6;
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    out.menuVisibleAfterClick = !document.getElementById("quick-menu").classList.contains("hidden");
    // 3) 长按 800ms → 撒娇气泡
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
    canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    out.bubbleText = document.getElementById("bubble-text")?.textContent?.slice(0, 20) || "";
    out.longPressFired = (document.getElementById("bubble-text")?.textContent || "").includes("安抚一只猫");
    return out;
  });
  console.log(JSON.stringify(res, null, 2));
  await new Promise((r) => setTimeout(r, 500));
  console.log("console errors:", JSON.stringify(errs));
} finally {
  await app.close().catch(() => {});
}
