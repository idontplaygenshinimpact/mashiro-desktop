// 验证：同会话 扫码(如需) → begin → detail 拿题目内容
import { chromium } from "playwright";

const ctx = await chromium.launchPersistentContext("D:/mianshi-agent/data/nowcoder-edge-profile", {
  channel: "msedge", headless: false, locale: "zh-CN", args: ["--disable-blink-features=AutomationControlled"],
});
await ctx.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://www.nowcoder.com/exam/test/68309503/summary", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(3000);

async function apiFetch(path, body) {
  return page.evaluate(async ([p, b]) => {
    const r = await fetch("https://gw-c.nowcoder.com" + p, {
      method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
      body: JSON.stringify(b),
    });
    return r.json();
  }, [path, body]);
}

async function begin() {
  return apiFetch("/api/sparta/test/begin", { paperId: 68309503 });
}
let r = await begin();
if (r.code !== 0) {
  console.log("⏳ 窗口里扫码登录（手机确认）…");
  const deadline = Date.now() + 3 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    r = await begin();
    if (r.code === 0) break;
  }
}
console.log("begin:", r.code, "testId:", r?.data?.testId);
const testId = r?.data?.testId;

// detail 变体
const variants = [
  { paperId: 68309503, testId },
  { testId },
  { paperId: 68309503 },
  { id: testId },
];
for (const b of variants) {
  const d = await apiFetch("/api/sparta/test/detail", b);
  const s = JSON.stringify(d);
  console.log(`detail(${JSON.stringify(b).slice(0, 50)}): code=${d.code} msg=${d.msg} len=${s.length}`);
  if (d.code === 0 && s.length > 300) {
    console.log("data keys:", Object.keys(d.data || {}).join(","));
    console.log(s.slice(0, 2200));
    break;
  }
}
await ctx.close();
process.exit(0);
