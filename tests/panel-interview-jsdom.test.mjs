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

test("最后一轮提交 → 自动结束 + 复盘报告显示", async () => {
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
    const review = window.document.getElementById("iv-review");
    assert.ok(!review.classList.contains("hidden"), "复盘区显示");
    assert.ok(review.textContent.includes("面试复盘"), "复盘报告上屏");
  });
});

test("手动点「结束面试」→ 复盘报告显示", async () => {
  await withPanel(async ({ window }) => {
    window.document.getElementById("iv-start").click();
    await tick();
    window.document.getElementById("iv-end").click();
    await tick(60);
    const review = window.document.getElementById("iv-review");
    assert.ok(!review.classList.contains("hidden"), "复盘区显示");
    assert.ok(review.textContent.includes("面试复盘"), "报告上屏");
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
