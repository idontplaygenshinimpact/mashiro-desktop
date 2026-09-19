// 全量 UI 截图：所有业务 Tab × 三态（原生/React/Vue）逐格截图，供视觉复核与机器审计。
// 为什么单独一份：scripts/shot-practice.mjs 只覆盖本次改动面（专项练习/清单/面试手写轮）；
// "所有 UI 效果都检查了吗"需要**全部 Tab × 三态**过一遍（27 格），才能发现"某格容器没挂/空白/塌陷"。
// 做法同 shot-panel.mjs：真 Chromium + file:// 打开 panel.html + 注入 mock IPC/fetch——
// 不启 Electron、不连运行中的 widget、不写数据库。
// 用法：node scripts/shot-all-tabs.mjs [输出目录]
import { chromium } from "playwright-core";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.resolve(process.argv[2] || path.join(ROOT, "output", "ui-all"));
const PANEL = path.join(ROOT, "desktop", "renderer", "panel.html");
if (!existsSync(PANEL)) { console.error("panel.html 不存在"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

const TABS = ["dashboard", "kb", "study", "crawl", "interview", "review", "jobs", "practice", "chat"];
const MODES = ["native", "react", "vue"];

const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message).slice(0, 140)));

await page.addInitScript(() => {
  const plan = { date: "2026-09-16", items: [
    { id: "p1", topic: "笔试题·区间和（多组询问）", why: "ACM 模式笔试题（自己读输入/自己输出）", source: "题库", level: "必会", grp: "算法与手写", done: false, hasFile: false, mode: "acm", challengeId: "acm-prefix-sum" },
    { id: "p2", topic: "事件循环与微任务", why: "面经高频考点", level: "必会", grp: "JavaScript 核心", done: false, hasFile: false },
  ] };
  const challenge = { id: "acm-prefix-sum", title: "区间和（多组询问）", category: "algorithm", difficulty: 2, frequency: 2, timeLimit: 10, mode: "acm", done: false, wrongCount: 1, description: "输入格式：第一行 n 与 q。\n输出格式：q 行。", skeleton: "// ACM\n" };
  const base = {
    ok: true, base: "http://127.0.0.1:8899", plan, files: [{ company: "字节跳动", title: "前端一面面经", dir: "output/2026-09-01" }],
    progress: { status: "idle", message: "暂无爬取任务", plan: { done: 1, total: 2 }, challenges: { done: 0, total: 1 }, review: { mastered: 0, total: 1, due: 0 }, jobs: { open: 0, applied: 0 } },
    week: { studyDone: 1, reviewDone: 0, challengeDone: 0, focusMinutes: 0, applyCount: 0, interviewCount: 0 }, weekSeries: [],
    stats: { chats: 0, reviewsDone: 0, interviewsDone: 0 }, review: { total: 1 }, hits: [], history: [], weak: [], mastery: [], trend: [], total: 1,
    list: [challenge], items: [], docs: 0, followups: 0, date: "2026-09-16", enabled: true,
  };
  const stubs = {
    getData: base, studyPlan: { ok: true, plan }, reviewDue: { ok: true, due: [] },
    invStart: { ok: true, session: { round: 1, roundType: "手写轮" }, question: "手写一个防抖函数，并说明边界", answerMode: "code", dimension: "代码能力", criteria: "c", boundary: "b" },
    patrolConfig: { ok: true, enabled: false },
  };
  const W = /** @type {any} */ (window);
  W.kanban = new Proxy({}, { get: (_t, k) => async () => (stubs[k] ?? base) });
  W.fetch = async (url) => {
    const u = String(url);
    /** @type {Record<string, unknown>} */ let j = base;
    if (u.includes("/api/challenges/detail")) j = { ok: true, detail: { ...challenge, testCode: "", ioCases: [{ input: "1", expected: "1" }] } };
    else if (u.includes("/api/challenges?")) j = { ok: true, total: 1, done: 0, left: 1, list: [challenge] };
    else if (u.includes("/api/oj/problems")) j = { ok: true, total: 0, problems: [], byCategory: [] };
    else if (u.includes("/api/oj/progress")) j = { ok: true, list: [], total: 0 };
    else if (u.includes("/api/study-plan")) j = { ok: true, plan };
    return { ok: true, status: 200, json: async () => j };
  };
});

await page.goto("file:///" + PANEL.replace(/\\/g, "/"), { waitUntil: "load" });
await page.waitForTimeout(800);

const report = [];
for (const tab of TABS) {
  for (const mode of MODES) {
    const name = `${tab}-${mode}`;
    try {
      await page.evaluate(async ([t, m]) => {
        const W = /** @type {any} */ (window);
        W.switchTab?.(t);
        await new Promise((r) => setTimeout(r, 120));
        W.switchRenderer?.(t, m);
      }, [tab, mode]);
      await page.waitForTimeout(mode === "native" ? 700 : 2200);
      const info = await page.evaluate(([t, m]) => {
        const box = document.getElementById(`${t}-${m}`);
        const r = box ? box.getBoundingClientRect() : null;
        const text = box ? (box.innerText || "").replace(/\s+/g, " ").trim() : "";
        const all = box ? [...box.querySelectorAll("*")] : [];
        const clickable = all.filter((e) => ["BUTTON", "A", "INPUT", "SELECT"].includes(e.tagName));
        const gradient = (e) => { const b = getComputedStyle(e).backgroundImage; return b && b !== "none"; };
        return {
          exists: !!box,
          h: r ? Math.round(r.height) : 0,
          textLen: text.length,
          textHead: text.slice(0, 60),
          els: all.length,
          tinyText: all.filter((e) => e.tagName !== "SUP" && !e.children.length && (e.textContent || "").trim() && parseFloat(getComputedStyle(e).fontSize) < 11).length,
          overflowX: all.filter((e) => e.scrollWidth > e.clientWidth + 2 && !["auto", "scroll"].includes(getComputedStyle(e).overflowX)).length,
          noLabel: clickable.filter((e) => !e.getAttribute("aria-label") && !e.getAttribute("title") && !(e.textContent || "").trim()).length,
          narrowCm: all.filter((e) => e.classList?.contains("cm-editor") && e.getBoundingClientRect().width < 120).length,
          gradientText: all.filter((e) => gradient(e) && !e.children.length && (e.textContent || "").trim()).length,
        };
      }, [tab, mode]);
      const file = path.join(OUT, `${name}.png`);
      const box = await page.$(`#${tab}-${mode}`);
      if (box && info.h > 0) await box.screenshot({ path: file });
      else await page.screenshot({ path: file });
      report.push(/** @type {Record<string, any>} */ ({ name, ...info }));
      const flag = !info.exists ? "❌ 容器缺失" : info.h < 60 ? `⚠ 高度仅 ${info.h}px` : info.textLen < 10 ? "⚠ 几乎无内容" : "✅";
      console.log(`${flag} ${name}  高=${info.h}px 文本=${info.textLen}字 元素=${info.els} | 小字=${info.tinyText} 溢出=${info.overflowX} 无标签=${info.noLabel} 窄CM=${info.narrowCm}`);
    } catch (e) {
      report.push(/** @type {Record<string, any>} */ ({ name, error: String(e.message).slice(0, 120) }));
      console.log(`❌ ${name} 截图失败: ${String(e.message).slice(0, 90)}`);
    }
  }
}

console.log("\n=== 汇总 ===");
console.log(`共 ${report.length} 格；容器缺失 ${report.filter((r) => r.exists === false).length}；高度<60px ${report.filter((r) => typeof r.h === "number" && r.h < 60).length}；含窄 CodeMirror ${report.filter((r) => Number(r.narrowCm) > 0).length}`);
console.log("控制台错误:", errors.length ? [...new Set(errors)].slice(0, 6).join(" | ") : "（无）");
console.log("输出目录:", OUT);
await browser.close();
