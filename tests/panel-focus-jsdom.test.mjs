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

// ============ 一键重启按钮（曾因主进程重建失败被吞 → 按钮永久卡 ⏳、重启永不发生） ============
test("一键重启失败路径（返回错误）：按钮恢复 + 明确提示", async () => {
  await withPanel(async ({ window, kanban }) => {
    const notifies = [];
    kanban.notify = (t, m) => notifies.push({ t, m });
    window.confirm = () => true; // jsdom 无 confirm，mock 自动确认
    kanban.restartApp = async () => ({ ok: false, error: "重启失败: 构建异常" });
    const btn = window.document.getElementById("restart-btn");
    assert.ok(btn, "重启按钮存在");
    btn.click();
    await tick(50);
    assert.equal(btn.disabled, false, "按钮恢复可点（此前永久卡 ⏳）");
    assert.equal(btn.textContent, "🔄 一键重启", "按钮文案恢复");
    assert.ok(notifies.some((n) => String(n.t).includes("重启失败")), "错误提示显示");
  });
});

test("一键重启 reject 路径：按钮同样恢复", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.confirm = () => true;
    kanban.restartApp = async () => { throw new Error("IPC 异常"); };
    const btn = window.document.getElementById("restart-btn");
    btn.click();
    await tick(50);
    assert.equal(btn.disabled, false, "按钮恢复");
  });
});

test("一键重启成功路径：正常触发不抛错", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.confirm = () => true;
    kanban.restartApp = async () => ({ ok: true });
    const btn = window.document.getElementById("restart-btn");
    assert.doesNotThrow(() => btn.click());
    await tick(30);
  });
});

test("一键重启取消确认：不触发 restartApp", async () => {
  await withPanel(async ({ window, kanban }) => {
    let called = 0;
    kanban.restartApp = async () => { called++; return { ok: true }; };
    window.confirm = () => false; // 取消
    window.document.getElementById("restart-btn").click();
    await tick(30);
    assert.equal(called, 0, "取消确认不重启");
  });
});
