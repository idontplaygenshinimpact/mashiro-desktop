// 「字段缺失不得渲染成字面量 undefined」护栏（2026-09-16）
// 由来：全量 UI 视觉复核（27 格 Tab×三态）时，视觉模型在「爬取」页报出"下拉选项显示 undefined、配置文字显示
// undefined"——DOM 取证确认是真的：`loadPatrolConfig`/`renderPatrolStatus` 直接拼 `String(r.intervalMin)`，
// 后端字段缺失时页面就出现"每 undefined 分钟"和一个"undefined 分钟"的 <option>。
// 这类"脏字面量泄漏到界面"的问题 jsdom 能查（不需要视觉模型），所以固化成断言：
// 面板各 Tab 在**字段残缺的宽返回**下渲染，页面上不得出现 "undefined"/"NaN"/"[object Object]"。
import { bootPanel, tick } from "./panel-helper.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const DIRTY = /undefined|NaN|\[object Object\]/;

test("爬取页：巡检配置字段缺失时不渲染 undefined（下拉选项 + 状态行）", async () => {
  const ctx = bootPanel({});
  const { window } = ctx;
  try {
    // 宽返回但**缺 intervalMin/lastRun/nextRun**：模拟"后端字段演进/契约漂移"
    window.kanban.patrolConfig = async () => ({ ok: true, enabled: true });
    await window.loadPatrolConfig();
    await tick(60);
    const status = window.document.getElementById("patrol-status").textContent || "";
    const options = [...window.document.querySelectorAll("#patrol-interval option")].map((o) => o.textContent || "");
    assert.doesNotMatch(status, DIRTY, `状态行不得出现脏字面量（实得「${status}」）`);
    for (const o of options) assert.doesNotMatch(o, DIRTY, `下拉选项不得出现脏字面量（实得「${o}」）`);
    assert.match(status, /每 — 分钟/, "缺失时给出占位符「—」，而不是 undefined");
  } finally {
    window.clearAllTimers?.();
    ctx.dom.window.close();
  }
});

test("爬取页：巡检配置正常时按真实值渲染（正对照，防「永远显示 —」）", async () => {
  const ctx = bootPanel({});
  const { window } = ctx;
  try {
    window.kanban.patrolConfig = async () => ({ ok: true, enabled: true, intervalMin: 45, lastRun: Date.now(), nextRun: Date.now() + 60000 });
    await window.loadPatrolConfig();
    await tick(60);
    const status = window.document.getElementById("patrol-status").textContent || "";
    assert.match(status, /每 45 分钟/, `正常值必须如实显示（实得「${status}」）`);
  } finally {
    window.clearAllTimers?.();
    ctx.dom.window.close();
  }
});

test("专项练习：筛选 chips 不出现两个同名「全部」（分组可辨）", async () => {
  const ctx = bootPanel({});
  const { window } = ctx;
  try {
    window.fetch = async (url) => {
      const u = String(url);
      const j = u.includes("/api/challenges?") ? { ok: true, total: 1, done: 0, left: 1, list: [
        { id: "c1", title: "手写防抖", category: "handwrite", difficulty: 1, frequency: 3, timeLimit: 10, mode: "core", done: false, wrongCount: 0, description: "x", skeleton: "" },
      ] } : { ok: true, list: [], items: [], plan: { items: [] } };
      return { ok: true, json: async () => j };
    };
    window.loadChallenges();
    await tick(80);
    const labels = [...window.document.querySelectorAll("#challenge-cats .oj-cat-chip")].map((e) => (e.textContent || "").trim());
    const plain = labels.filter((l) => l === "全部");
    assert.equal(plain.length, 0, `不应存在两个同名「全部」chip（视觉复核发现分组难辨）：${labels.join(" / ")}`);
    assert.ok(labels.includes("全部分类"), "分类组的「全部」应改名为「全部分类」");
    assert.ok(labels.includes("📋 全部"), "状态组保留 📋 全部");
  } finally {
    window.clearAllTimers?.();
    ctx.dom.window.close();
  }
});
