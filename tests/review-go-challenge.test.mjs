// 复习卡「✍️ 去做题」入口 + gotoChallenge 跨模式回退 护栏（2026-09-16）
// 背景：复习卡（答错自动建卡）已经带 `challenge_id`，但复习 Tab 里没有回到题目的入口——
// 复习时发现"这题其实不会写"只能干看讲解。本护栏盯住两件事：
//   ① 卡片关联了题目 → 卡片头出现「✍️ 去做题」；没关联 → 不出现（不给假入口）；
//   ② 复习卡只存题目 id、没有 mode → `gotoChallenge(id, "")` 必须**自动在 core/acm 之间回退**查找
//      （ACM 题只出现在 acm 模式列表里，不回退就永远找不到）。
import { bootPanel, tick } from "./panel-helper.mjs";
import test from "node:test";
import assert from "node:assert/strict";

/** 造一道题 + 一个复习队列，按模式返回列表（模拟"ACM 题只在 acm 模式里"） */
function boot({ withChallenge = true } = {}) {
  const ctx = bootPanel({});
  const { window } = ctx;
  const acm = { id: "acm-x", title: "区间和（多组询问）", category: "algorithm", difficulty: 2, frequency: 2, timeLimit: 10, mode: "acm", done: false, wrongCount: 1, description: "输入格式：…", skeleton: "// ACM\n" };
  const card = {
    id: "c1", topic: "笔试题·区间和（多组询问）", question: "请完整实现", answer: "", source: "ACM 笔试题库",
    type: "algo", priority: "必会", history: [], stage: { label: "🆕 首次复习" }, memPct: 0,
    challengeId: withChallenge ? "acm-x" : "",
  };
  window.kanban.reviewDue = async () => ({ ok: true, due: [card], stats: {}, trend: { trend: [], streak: 0 }, todayReviewed: [] });
  window.fetch = async (url) => {
    const u = String(url);
    const mode = new URL(u, "http://x").searchParams.get("mode") || "core";
    const j = u.includes("/api/challenges/detail") ? { ok: true, detail: { ...acm, testCode: "", ioCases: [] } }
      : u.includes("/api/challenges?")
      ? { ok: true, total: mode === "acm" ? 1 : 0, done: 0, left: 1, list: mode === "acm" ? [acm] : [] }
      : { ok: true, list: [], items: [], plan: { items: [] }, due: [card], stats: {}, trend: { trend: [], streak: 0 } };
    return { ok: true, status: 200, json: async () => j };
  };
  return { ctx, window, card };
}

test("复习卡关联题目时出现「✍️ 去做题」，未关联时不出现", async () => {
  for (const withChallenge of [true, false]) {
    const { ctx, window } = boot({ withChallenge });
    try {
      window.loadReview();
      await tick(120);
      const el = window.document.getElementById("rc-go-challenge");
      if (withChallenge) {
        assert.ok(el, "关联题目的复习卡应出现「✍️ 去做题」按钮");
        assert.match(el.textContent, /去做题/, "按钮文案");
      } else {
        assert.equal(el, null, "未关联题目的复习卡不应出现入口（不给假入口）");
      }
    } finally {
      window.clearAllTimers?.();
      ctx.dom.window.close();
    }
  }
});

test("gotoChallenge(id, \"\") 自动跨模式回退：core 找不到时切到 acm 并展开该题", async () => {
  const { ctx, window } = boot();
  try {
    window.loadChallenges(); // 先以 core 加载（列表为空）
    await tick(80);
    assert.equal(window.document.querySelectorAll("#challenge-list .job-item").length, 0, "前提：core 模式下没有这道 ACM 题");
    await window.gotoChallenge("acm-x", ""); // 复习卡只给 id，不给模式
    await tick(200);
    const items = [...window.document.querySelectorAll("#challenge-list .job-item")];
    assert.equal(items.length, 1, "应在 acm 模式下找到并渲染该题（跨模式回退生效）");
    assert.match(items[0].textContent, /区间和/, "渲染的是目标题");
    assert.ok(items[0].querySelector(".ch-editor"), "应自动展开该题编辑器（一步到做题）");
  } finally {
    window.clearAllTimers?.();
    ctx.dom.window.close();
  }
});
