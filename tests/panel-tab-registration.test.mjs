// Tab 登记完整性护栏（2026-09-16）：防止"三态矩阵登记了、但容器没建 → 切换静默失效"
// 背景（真浏览器渲染检查实测踩到）：`switchRenderer(tab, mode)` 第一行就要求 `#<tab>-native` 存在，
// 否则**静默 return**；而容器只由 `initRendererSwitches()` 对 **`TAB_LABELS` 里的 Tab** 创建。
// 新增「专项练习」Tab 时把它加进了 FRAMEWORK_TABS / rendererState / panel.html，却漏了 TAB_LABELS ——
// 结果是：切换条点了没反应（那一列三态切换等于不存在），而 jsdom 测试全绿（它们直接挂框架组件，
// 不走 switchRenderer 这条真实路径）。这类"登记表之间不同步 → 静默失效"必须由测试盯住。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const R = (p) => new URL("../" + p, import.meta.url);
const core = readFileSync(R("desktop/renderer/panel-core.js"), "utf8");
const html = readFileSync(R("desktop/renderer/panel.html"), "utf8");

const listOf = (src, key) => {
  const m = src.match(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`));
  assert.ok(m, `panel-core 应有 ${key} 登记`);
  return m[1].split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
};
const tabLabels = (() => {
  const m = core.match(/const TAB_LABELS = \{([\s\S]*?)\};/);
  assert.ok(m, "panel-core 应有 TAB_LABELS");
  return [...m[1].matchAll(/(\w+):\s*"/g)].map((x) => x[1]);
})();

test("每个登记了框架版的 Tab 都必须在 TAB_LABELS 里（否则容器不建 → 切换静默失效）", () => {
  const registered = new Set([...listOf(core, "react"), ...listOf(core, "vue")]);
  assert.ok(tabLabels.length >= 9, `TAB_LABELS 应覆盖全部业务 Tab（实得 ${tabLabels.length}）`);
  const missing = [...registered].filter((t) => !tabLabels.includes(t));
  assert.deepEqual(missing, [], `这些 Tab 登记了三态但不在 TAB_LABELS（initRendererSwitches 不会建容器）：${missing.join(", ")}`);
});

test("TAB_LABELS 里的每个 Tab 都要有 section 与切换按钮（否则容器/入口缺一个）", () => {
  const noSection = tabLabels.filter((t) => !html.includes(`id="tab-${t}"`));
  assert.deepEqual(noSection, [], `缺 <section id="tab-…">：${noSection.join(", ")}`);
  const noButton = tabLabels.filter((t) => !html.includes(`data-tab="${t}"`));
  assert.deepEqual(noButton, [], `缺 .tab[data-tab] 按钮：${noButton.join(", ")}`);
});

test("rendererState 覆盖所有业务 Tab（切换状态机不能漏 Tab）", () => {
  const m = core.match(/const rendererState = \{([\s\S]*?)\};/);
  assert.ok(m, "panel-core 应有 rendererState");
  const keys = [...m[1].matchAll(/(\w+):\s*"/g)].map((x) => x[1]);
  const missing = tabLabels.filter((t) => !keys.includes(t));
  assert.deepEqual(missing, [], `rendererState 缺：${missing.join(", ")}`);
});

test("真浏览器渲染断言（本护栏的由来）：切到框架版专项练习后容器真的可见且有内容", async () => {
  // 这条是"看得见"的版本——jsdom 覆盖不到布局/可见性；用真 Chromium（不启 Electron、不连运行中的 app）
  let chromium;
  try { ({ chromium } = await import("playwright-core")); } catch { return; } // 没装 playwright 时跳过（CI 仅装 playwright-core）
  const browser = await chromium.launch({ args: ["--allow-file-access-from-files"] });
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
    await page.addInitScript(() => {
      const base = { ok: true, base: "http://127.0.0.1:8899", plan: { date: "2026-09-16", items: [] }, files: [], progress: { status: "idle" } };
      const W = /** @type {any} */ (window);
      W.kanban = new Proxy({}, { get: () => async () => base });
      W.fetch = async () => ({ ok: true, status: 200, json: async () => base });
    });
    await page.goto("file:///" + new URL("../desktop/renderer/panel.html", import.meta.url).pathname.replace(/^\//, "").replace(/\//g, "/"), { waitUntil: "load" });
    await page.waitForTimeout(700);
    for (const mode of ["react", "vue"]) {
      const r = await page.evaluate(async (m) => {
        const W = /** @type {any} */ (window);
        W.switchTab?.("practice");
        W.switchRenderer?.("practice", m);
        await new Promise((x) => setTimeout(x, 2200));
        const el = document.getElementById(`practice-${m}`);
        const rect = el ? el.getBoundingClientRect() : null;
        return { exists: !!el, h: rect ? Math.round(rect.height) : 0, text: el ? (el.innerText || "").slice(0, 40) : "" };
      }, mode);
      assert.ok(r.exists, `#practice-${mode} 容器应存在（TAB_LABELS 漏登记时这里会是 false）`);
      assert.ok(r.h > 40, `#practice-${mode} 应真实渲染出内容（实得高度 ${r.h}px）`);
      assert.match(r.text, /专项练习/, `#practice-${mode} 应渲染出框架版专项练习（实得「${r.text}」）`);
    }
  } finally {
    await browser.close();
  }
});
