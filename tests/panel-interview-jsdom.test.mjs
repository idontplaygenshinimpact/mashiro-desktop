// tests/panel-interview-jsdom.test.mjs —— 模拟面试前端全流程交互 jsdom 测试
// 覆盖用户主路径：开始面试→问题显示→提交回答→评分+下一问→薄弱点命中→结束→复盘。
// 背景：iv-answer-area 曾是 class 被当 id 用（开始面试必崩、问题永不显示）——本文件是
//       该回归的完整护栏，修复前每个用例都会挂。
import test from "node:test";
import assert from "node:assert/strict";
import { withPanel, tick } from "./panel-helper.mjs";

test("开始面试 → 问题显示 + 回答区可见 + 状态切面试中", async () => {
  await withPanel(async ({ window }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    const q = window.document.getElementById("iv-question");
    assert.equal(q.textContent, "请先做个自我介绍，并讲讲你的项目经历", "问题应显示");
    const area = window.document.getElementById("iv-answer-area");
    assert.notEqual(area.style.display, "none", "回答区应可见");
    assert.match(window.document.getElementById("iv-status").textContent, /面试中/);
  });
});

test("提交回答 → 评分条渲染 + 下一问显示", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    let answered = null;
    kanban.invAnswer = async (a) => { answered = a; return {
      ok: true, scores: { tech: 80, expr: 70, depth: 60, edge: 50, reflect: 40 }, total: 60, comment: "不错",
      finished: false, question: "讲讲 React Fiber", roundType: "技术轮", dimension: "原理", basis: "追问",
      criteria: "c", boundary: "b", weakHit: false, weakTopic: "",
    }; };
    window.document.getElementById("iv-answer").value = "事件循环是...";
    window.document.getElementById("iv-send").click();
    await tick(60);
    assert.equal(answered, "事件循环是...", "回答文本传给后端");
    assert.equal(window.document.getElementById("iv-question").textContent, "讲讲 React Fiber", "下一问显示");
    const scores = window.document.getElementById("iv-scores");
    assert.ok(scores.innerHTML.includes("score-bar") || scores.innerHTML.length > 0, "评分条渲染");
    assert.ok(scores.innerHTML.includes("不错"), "点评显示");
  });
});

test("薄弱点命中轮 → 界面出现「薄弱点命中」提示", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    kanban.invAnswer = async () => ({
      ok: true, scores: { tech: 50, expr: 50, depth: 50, edge: 50, reflect: 50 }, total: 50, comment: "一般",
      finished: false, question: "再讲防抖节流", roundType: "八股轮", dimension: "原理", basis: "薄弱点",
      criteria: "c", boundary: "b", weakHit: true, weakTopic: "防抖节流",
    });
    window.document.getElementById("iv-answer").value = "回答";
    window.document.getElementById("iv-send").click();
    await tick(60);
    const scores = window.document.getElementById("iv-scores");
    assert.ok(scores.innerHTML.includes("薄弱点命中"), "命中提示显示（含主题）");
    assert.ok(scores.innerHTML.includes("防抖节流"));
  });
});

test("最后一轮提交 → 自动结束 + 复盘报告弹窗显示", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    kanban.invAnswer = async () => ({
      ok: true, scores: { tech: 90, expr: 90, depth: 90, edge: 90, reflect: 90 }, total: 90, comment: "很好",
      finished: true, question: "", roundType: "", dimension: "", basis: "", criteria: "", boundary: "", weakHit: false, weakTopic: "",
    });
    kanban.invEnd = async () => ({ ok: true, report: "## 面试复盘（前端）\n### 总体评价\n优秀", weakTotal: 0, weakCovered: 0, weakCoveredTopics: [], hint: "" });
    window.document.getElementById("iv-answer").value = "回答";
    window.document.getElementById("iv-send").click();
    await tick(80);
    assert.match(window.document.getElementById("iv-status").textContent, /面试结束|正在生成复盘/, "状态切结束");
    const overlay = window.document.getElementById("iv-report-overlay");
    assert.ok(overlay, "复盘弹窗容器存在");
    assert.ok(!overlay.classList.contains("hidden"), "复盘弹窗打开（毛玻璃弹窗展示报告）");
    const body = window.document.getElementById("iv-report-body");
    assert.ok(body.innerHTML.includes("面试复盘"), "报告 Markdown 渲染上屏");
    assert.ok(body.querySelector("h3, h4"), "Markdown 标题元素渲染（## → h4）");
  });
});

test("手动点「结束面试」→ 复盘报告弹窗显示", async () => {
  await withPanel(async ({ window }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    window.document.getElementById("iv-end").click();
    await tick(60);
    const overlay = window.document.getElementById("iv-report-overlay");
    assert.ok(!overlay.classList.contains("hidden"), "复盘弹窗打开");
    assert.ok(window.document.getElementById("iv-report-body").textContent.includes("面试复盘"), "报告上屏");
    assert.match(window.document.getElementById("iv-status").textContent, /面试已结束/);
  });
});

test("空回答提交 → 不调用后端（按钮安全）", async () => {
  await withPanel(async ({ window, kanban }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    let called = false;
    kanban.invAnswer = async () => { called = true; return { ok: true }; };
    window.document.getElementById("iv-answer").value = "   ";
    window.document.getElementById("iv-send").click();
    await tick();
    assert.equal(called, false, "空回答不应提交");
  });
});

// ---------- 💻 手写轮代码作答（用户反馈 2026-09：手写题用纯文本框太难受）----------
const CODE_Q = {
  ok: true, round: 5, roundType: "手写/场景题", nextRoundType: "手写/场景题",
  question: "手写一个 debounce（防抖）函数", totalRounds: 9, weakQueue: [], depth: 0,
  dimension: "代码能力", basis: "手写轮", criteria: "leading/trailing", boundary: "不考框架",
  answerMode: "code",
};

test("手写轮（answerMode=code）→ 代码编辑器形态：编辑器栏可见 + 行号 + 隐藏语音按钮", async () => {
  await withPanel(async ({ window, kanban }) => {
    kanban.invStart = async () => CODE_Q;
    window.document.getElementById("iv-start").click();
    await tick();
    const area = window.document.getElementById("iv-answer-area");
    assert.ok(area.classList.contains("iv-code"), "作答区进入代码模式");
    assert.ok(!window.document.getElementById("iv-editor-bar").classList.contains("hidden"), "编辑器栏显示");
    assert.equal(window.document.getElementById("iv-mic").style.display, "none", "代码轮隐藏语音按钮");
    assert.match(window.document.getElementById("iv-gutter").textContent, /^1$/, "行号槽可用");
    assert.match(window.document.getElementById("iv-answer").placeholder, /写代码作答/);
  });
});

test("普通轮（answerMode=text）→ 保持文本框形态（不误开编辑器）", async () => {
  await withPanel(async ({ window }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    const area = window.document.getElementById("iv-answer-area");
    assert.ok(!area.classList.contains("iv-code"), "非手写轮不进代码模式");
    assert.ok(window.document.getElementById("iv-editor-bar").classList.contains("hidden"), "编辑器栏隐藏");
    assert.notEqual(window.document.getElementById("iv-mic").style.display, "none", "语音按钮可见");
  });
});

test("代码模式：Tab 插入两个空格（缩进），Enter 自动缩进（{ 后多缩一级）", async () => {
  await withPanel(async ({ window, kanban }) => {
    kanban.invStart = async () => CODE_Q;
    window.document.getElementById("iv-start").click();
    await tick();
    const box = window.document.getElementById("iv-answer");
    const fire = (key, opts = {}) => {
      const ev = new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts });
      Object.defineProperty(ev, "target", { value: box });
      box.dispatchEvent(ev);
    };
    // Tab → 两个空格
    box.value = "";
    box.selectionStart = box.selectionEnd = 0;
    fire("Tab");
    assert.equal(box.value, "  ", "Tab 插入两个空格（不切走焦点）");
    // Enter（行尾是 {）→ 换行 + 沿用缩进 + 多缩一级
    box.value = "function debounce(fn) {";
    box.selectionStart = box.selectionEnd = box.value.length;
    fire("Enter");
    assert.equal(box.value, "function debounce(fn) {\n  ", "Enter 自动缩进（{ 后多一级）");
    // Enter（普通行）→ 沿用当前缩进
    box.value = "  const t = 1;";
    box.selectionStart = box.selectionEnd = box.value.length;
    fire("Enter");
    assert.equal(box.value, "  const t = 1;\n  ", "Enter 沿用当前缩进");
    // 行号随内容增长
    box.value = "a\nb\nc";
    box.dispatchEvent(new window.Event("input", { bubbles: true }));
    assert.equal(window.document.getElementById("iv-gutter").textContent, "1\n2\n3", "行号与行数同步");
  });
});

test("残留会话自愈：start 报「已有面试进行中」→ 自动 end 旧会话 → 重新开始 → 问题显示", async () => {
  await withPanel(async ({ window, kanban, alerts }) => {
    const starts = [];
    let ends = 0;
    // 第一次 start 被残留会话拒绝，第二次成功
    kanban.invStart = async () => {
      starts.push(starts.length);
      if (starts.length === 1) return { error: "已有一场面试进行中，先结束（end_interview）或继续回答", session: {} };
      return { ok: true, round: 1, roundType: "开场与自我介绍", question: "自我介绍并讲一个项目", totalRounds: 9, weakQueue: [], depth: 0 };
    };
    kanban.invEnd = async () => { ends++; return { ok: true, report: "旧场复盘" }; };
    window.document.getElementById("iv-start").click();
    await tick(80);
    assert.equal(ends, 1, "旧会话被自动收尾");
    assert.equal(starts.length, 2, "自动重试 start");
    const q = window.document.getElementById("iv-question");
    assert.equal(q.textContent, "自我介绍并讲一个项目", "问题最终显示");
    assert.equal(alerts.length, 0, "不弹错误框（自愈成功）");
  });
});

test("残留会话且收尾失败 → 明确提示（不崩、可重试）", async () => {
  await withPanel(async ({ window, kanban, alerts }) => {
    kanban.invStart = async () => ({ error: "已有一场面试进行中，先结束（end_interview）或继续回答", session: {} });
    kanban.invEnd = async () => ({ error: "LLM 不可用" });
    window.document.getElementById("iv-start").click();
    await tick(60);
    assert.ok(alerts.length >= 1, "有明确错误提示");
    assert.match(alerts[0], /启动失败/);
    // 按钮恢复可重试
    const btn = window.document.getElementById("iv-start");
    assert.equal(btn.disabled, false, "按钮恢复");
  });
});

test("进行中会话 → 渲染「继续上一场」按钮 → 点击恢复面试中形态（C8 恢复闭环）", async () => {
  await withPanel(async ({ window, kanban }) => {
    kanban.invStatus = async () => ({
      ok: true, active: true, round: 3, roundType: "八股穿插", question: "讲讲事件循环的顺序", basis: "b", dimension: "d", criteria: "c", boundary: "bd", depth: 0, totalRounds: 9, roundsCount: 2,
      weakQueue: [], scoreSum: { tech: 80, expr: 80, depth: 80, edge: 80, reflect: 80, total: 400 },
    });
    window.switchTab("interview");
    await tick();
    const resumeBtn = window.document.getElementById("iv-resume");
    assert.ok(!resumeBtn.classList.contains("hidden"), "有进行中会话 → 显示继续按钮");
    assert.match(resumeBtn.textContent, /第 3 轮/, "按钮标注续接轮次");
    resumeBtn.click();
    await tick();
    const session = window.document.getElementById("interview-session");
    assert.ok(!session.classList.contains("hidden"), "点击后切换面试中形态");
    assert.ok(window.document.getElementById("iv-question").textContent.includes("事件循环"), "恢复当前问题");
    assert.match(window.document.getElementById("iv-status").textContent, /第 3 轮/);
  });
});

test("无进行中会话 → 「继续上一场」按钮隐藏", async () => {
  await withPanel(async ({ window, kanban }) => {
    kanban.invStatus = async () => ({ ok: true, active: false });
    window.switchTab("interview");
    await tick();
    const resumeBtn = window.document.getElementById("iv-resume");
    // switchTab 顶层会先以 mock 空库跑一遍 → 保证始终 hidden
    assert.ok(resumeBtn.classList.contains("hidden"), "无会话 → 按钮隐藏");
  });
});
