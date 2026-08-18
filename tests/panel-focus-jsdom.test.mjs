// tests/panel-focus-jsdom.test.mjs —— 专注监督 + 面板基础交互 jsdom 回归测试
// 背景：focus-goal 输入框缺失 → 点「🍅 25 分钟」报 null.value（HTML 从未有该元素）
// 本测试验证专注按钮链路（请求正确/不崩）+ 面板元素一致性由 panel-dom-consistency 兜底。
import test from "node:test";
import assert from "node:assert/strict";
import { withPanel, tick } from "./panel-helper.mjs";

test("点击「🍅 25 分钟」→ 请求 /api/focus/start（含目标）", async () => {
  await withPanel(({ window, calls }) => {
    const btn = window.document.getElementById("focus-25");
    assert.ok(btn, "focus-25 按钮应存在");
    const goalInput = window.document.getElementById("focus-goal");
    assert.ok(goalInput, "focus-goal 输入框应存在（此前缺失导致 null.value 崩溃）");
    goalInput.value = "刷完动态规划 5 题";
    assert.doesNotThrow(() => btn.click());
    const start = calls.find((c) => c.url.includes("/api/focus/start"));
    assert.ok(start, "应请求 /api/focus/start");
    assert.equal(start.method, "POST");
  });
});

test("点击「🍅 45 分钟」与「🚫 名单」不崩", async () => {
  await withPanel(({ window }) => {
    assert.doesNotThrow(() => window.document.getElementById("focus-45").click());
    assert.doesNotThrow(() => window.document.getElementById("focus-blacklist-toggle").click());
  });
});

test("学习清单主列表「📖 学习」按钮有响应：点击打开讲解弹窗", async () => {
  await withPanel(async ({ window }) => {
    await tick(60); // 等顶层 loadStudyPlan 异步渲染完成
    const list = window.document.getElementById("study-list");
    assert.ok(list, "study-list 存在");
    const learnBtn = list.querySelector(".s-learn");
    assert.ok(learnBtn, "主列表应渲染「学习」按钮（清单有数据时）");
    const overlay = window.document.getElementById("study-detail-overlay");
    assert.ok(overlay.classList.contains("hidden"), "初始弹窗隐藏");
    assert.doesNotThrow(() => learnBtn.click());
    await tick(30);
    assert.ok(!overlay.classList.contains("hidden"), "点击学习后弹窗应打开（此前按钮无事件 → 没反应）");
  });
});
