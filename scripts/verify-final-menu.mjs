// 最终测量：菜单不溢出 + 不挡角色 + 模拟单击/长按
import { _electron } from "playwright";
const app = await _electron.launch({
  executablePath: "D:/mianshi-agent/node_modules/electron/dist/electron.exe",
  args: ["desktop/main.mjs"], cwd: "D:/mianshi-agent",
});
try {
  let win = null;
  for (let i = 0; i < 30 && !win; i++) {
    win = app.windows().find((w) => w.url().includes("index.html")) || null;
    if (!win) await new Promise((r) => setTimeout(r, 500));
  }
  if (!win) throw new Error("桌宠窗口未出现");
  const errs = [];
  win.on("console", (msg) => { if (msg.type() === "error") errs.push(msg.text().slice(0, 100)); });
  await win.waitForLoadState("domcontentloaded");
  await new Promise((r) => setTimeout(r, 3000));

  const res = await win.evaluate(async () => {
    const out = {};
    const menu = document.getElementById("quick-menu");
    menu.classList.remove("hidden");
    const mr = menu.getBoundingClientRect();
    out.menuW = Math.round(mr.width);
    out.menuX = Math.round(mr.x);
    out.fits = mr.left >= 0 && mr.right <= window.innerWidth;
    out.buttonsVisible = [...document.querySelectorAll(".qm-btn")].every((b) => {
      const r = b.getBoundingClientRect();
      return r.right <= window.innerWidth && r.left >= 0;
    });
    // 模拟单击 → 菜单显示
    menu.classList.add("hidden");
    const canvas = document.getElementById("live2d");
    const cx = window.innerWidth / 2, cy = window.innerHeight * 0.6;
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    out.menuShownByClick = !menu.classList.contains("hidden");
    // 长按 → 撒娇
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
    canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    out.longPressBubble = (document.getElementById("bubble-text")?.textContent || "").includes("安抚一只猫");
    return out;
  });
  console.log(JSON.stringify(res, null, 2));
  await new Promise((r) => setTimeout(r, 400));
  console.log("console errors:", JSON.stringify(errs));
} finally {
  await app.close().catch(() => {});
}
