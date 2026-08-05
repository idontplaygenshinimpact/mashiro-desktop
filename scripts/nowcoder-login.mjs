// 牛客 Edge 内核登录（可靠版）：登录成功 = NOWCODERUID cookie 出现 + begin API 通过
// 窗口保持打开直到真正登录成功，手机扫码后需在手机上确认"登录网页版"
import { chromium } from "playwright";
import path from "node:path";

const PROFILE_DIR = path.join(import.meta.dirname, "..", "data", "nowcoder-edge-profile");

console.log("⏳ 打开 Edge 内核窗口——请扫码登录牛客，手机端确认后等待本脚本提示成功（窗口保持打开）");
const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1200, height: 820 },
  locale: "zh-CN",
  args: ["--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.nowcoder.com", { waitUntil: "domcontentloaded", timeout: 60000 });

const deadline = Date.now() + 5 * 60 * 1000;
let ok = false;
while (Date.now() < deadline) {
  await page.waitForTimeout(2500);
  // 硬指标 1：NOWCODERUID cookie 存在
  const cookies = await ctx.cookies("https://www.nowcoder.com");
  const hasUid = cookies.some((c) => c.name === "NOWCODERUID" && c.value.length > 10);
  if (!hasUid) { console.log("⏳ 等待登录…（手机扫码后需在手机确认「登录网页版」）"); continue; }
  // 硬指标 2：begin API 通过
  const beginOk = await page.evaluate(async () => {
    try {
      const r = await fetch("https://gw-c.nowcoder.com/api/sparta/test/begin", {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ paperId: 68309503 }),
      });
      const j = await r.json();
      return j.code === 0;
    } catch { return false; }
  });
  if (beginOk) { ok = true; break; }
  console.log("⏳ 已检测到登录 cookie，校验答题权限中…");
}
if (!ok) {
  console.log("❌ 未完成登录（5 分钟超时）——请确认手机扫码后在手机上点了确认");
  await ctx.close();
  process.exit(1);
}
console.log("✅ 登录成功（NOWCODERUID ✓ + begin API ✓），登录态已保存 → " + PROFILE_DIR);
await ctx.close();
process.exit(0);
