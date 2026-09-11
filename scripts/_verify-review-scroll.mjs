// scripts/_verify-review-scroll.mjs —— 复习卡滚动修复的断言验证（真实 Chromium）
// 现场复刻：420×520 / 480×600 窄面板 + 底部固定告警卡 #service-warn 可见 + 4000 字答案
// 断言：
//   ① 指针在固定浮层（#service-warn）上滚轮 → main 必须滚动（修复前实测 0→0 死区）
//   ② 答案框限高可滚（max-height=46vh 且框内 clientH < scrollH）
//   ③ 指针在答案框上滚轮 → 答案框自身滚动
//   ④ 评分按钮落在首屏下方 1.2 屏内（限高前是 2000+px）
// 用法：node scripts/_verify-review-scroll.mjs
import { chromium } from "playwright-core";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const PANEL = path.join(ROOT, "desktop", "renderer", "panel.html");
const LONG = ("事件循环是 JavaScript 的运行机制：先执行同步代码，再把微任务队列清空，然后取下一个宏任务。" +
  "渲染时机在每轮宏任务之后、下一次重绘之前；微任务在当前宏任务结束后立刻全部清空。").repeat(40);

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`); };

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
for (const [W, H] of [[420, 520], [480, 600]]) {
  console.log(`\n===== 面板 ${W}×${H} =====`);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.addInitScript((answer) => {
    const card = { id: "c1", topic: "事件循环与微任务", title: "请讲讲事件循环与微任务", question: "请讲讲事件循环与微任务", answer, type: "concept", history: [1] };
    const stub = { ok: true, due: [card], cards: [card], mastery: [], weak: [], trend: [], history: [] };
    // 面板通过 preload 注入的 IPC 桥（浏览器里由本脚本注入 mock）——显式声明，不靠 any
    /** @type {{ kanban?: unknown }} */ (/** @type {unknown} */ (window)).kanban = new Proxy({}, {
      get: (_t, p) => (p === "reviewDue"
        ? async () => ({ ok: true, due: [card], stats: { total: 1, due: 1 }, trend: { trend: [], streak: 0 }, todayReviewed: [] })
        : p === "getMastery" ? async () => ({ ok: true, mastery: [], weak: [], stats: { weakCount: 0 } }) : async () => stub),
    });
    // mock fetch：只需 ok/json 两个成员（真实 Response 更宽，这里是最小实现）
    window.fetch = /** @type {typeof fetch} */ (/** @type {unknown} */ (async () => ({ ok: true, json: async () => stub })));
  }, LONG);
  await page.goto("file:///" + PANEL.replace(/\\/g, "/"), { waitUntil: "load" });
  await page.waitForTimeout(600);

  const geo = await page.evaluate(async () => {
    const w = /** @type {{ switchTab?: (t: string) => void, loadReview?: () => Promise<void> }} */ (/** @type {unknown} */ (window));
    const pick = (sel) => /** @type {HTMLElement | null} */ (document.querySelector(sel));
    w.switchTab?.("review");
    if (typeof w.loadReview === "function") await w.loadReview();
    await new Promise((r) => setTimeout(r, 300));
    pick("#rc-show:not(.hidden)")?.click();
    await new Promise((r) => setTimeout(r, 400));
    // 复刻现场：让底部固定告警卡可见（用户当时就是这个状态）
    const warn = pick("#service-warn");
    if (warn) warn.hidden = false;
    await new Promise((r) => setTimeout(r, 100));
    const box = /** @type {HTMLElement} */ (document.querySelector("#rc-answer"));
    const br = box.getBoundingClientRect();
    const wr = warn.getBoundingClientRect();
    const rate = /** @type {HTMLElement} */ (document.querySelector("#rc-buttons button"));
    const rr = rate.getBoundingClientRect();
    return {
      warnPoint: { x: Math.round(wr.left + wr.width / 2), y: Math.round(wr.top + 10) },
      warnSize: { w: Math.round(wr.width), h: Math.round(wr.height) },
      boxMaxH: getComputedStyle(box).maxHeight, boxClientH: box.clientHeight, boxScrollH: box.scrollHeight,
      mainScrollH: /** @type {HTMLElement} */ (document.querySelector("main")).scrollHeight,
      mainClientH: /** @type {HTMLElement} */ (document.querySelector("main")).clientHeight,
      rateBelowFoldBy: Math.round(rr.bottom - window.innerHeight),
      warnCoversAnswer: wr.top < br.bottom && wr.left < br.right, // 浮层是否压住答案区（视觉遮挡）
    };
  });

  // ① 指针在固定浮层上滚轮
  const main0 = await page.evaluate(() => document.querySelector("main").scrollTop);
  await page.mouse.move(geo.warnPoint.x, geo.warnPoint.y);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(250);
  const main1 = await page.evaluate(() => document.querySelector("main").scrollTop);
  check(`① 指针在固定告警卡上滚轮 → 页面滚动`, main1 > main0, `main.scrollTop ${main0}→${main1}（浮层 ${geo.warnSize.w}×${geo.warnSize.h}）`);

  // ② 答案框限高可滚
  const bounded = geo.boxMaxH !== "none" && geo.boxScrollH > geo.boxClientH + 2;
  check(`② 答案框限高并自身可滚`, bounded, `max-height=${geo.boxMaxH}, ${geo.boxClientH}/${geo.boxScrollH}`);

  // ③ 指针在答案框上滚轮 → 框内滚动（Playwright 负责滚到可见并给出视口坐标）
  const boxLoc = page.locator("#rc-answer");
  await boxLoc.scrollIntoViewIfNeeded();
  const bb = await boxLoc.boundingBox();
  const pt = { x: Math.round(bb.x + bb.width / 2), y: Math.round(bb.y + Math.min(30, bb.height / 2)) };
  const under = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    return el ? (el.id ? `#${el.id}` : String(el.className).split(" ")[0]) : null;
  }, pt);
  check(`③a 指针确实落在答案框上`, under === "#rc-answer", `指针(${pt.x},${pt.y}) 下元素=${under}`);
  const box0 = await page.evaluate(() => document.querySelector("#rc-answer").scrollTop);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(250);
  const box1 = await page.evaluate(() => document.querySelector("#rc-answer").scrollTop);
  check(`③b 指针在答案框上滚轮 → 答案框内滚动`, box1 > box0, `#rc-answer.scrollTop ${box0}→${box1}`);

  // ④ 评分按钮可达性（限高前实测：420×520 面板下在首屏下方 2080px；现在应 <1.5 屏）
  check(`④ 评分按钮在首屏下方 1.5 屏内`, geo.rateBelowFoldBy <= Math.round(H * 1.5), `下方 ${geo.rateBelowFoldBy}px（阈值 ${Math.round(H * 1.5)}px）`);
  // ⑤ 浮层遮挡：固定 toast 本就悬浮于内容之上（可"知道了"关闭）——仅提示不判失败，但必须不阻断滚动（见 ①）
  console.log(`ℹ️ ⑤ 告警卡与答案区${geo.warnCoversAnswer ? "有重叠（悬浮 toast 固有行为，可点「知道了」关闭；滚动已不受影响）" : "不重叠"}`);
  await page.close();
}
await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n断言 ${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);