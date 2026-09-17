// 面试代码轮的 CodeMirror 6 接线护栏（2026-09-16）
// 背景：面试「手写轮」原来是手搓 textarea（Tab/Enter 缩进手工实现），用户反馈"写代码太难受"；
// 专项练习升级 CodeMirror 6 后，面试代码轮复用同一产物（按需注入），缺产物时回落原 textarea。
// 注意：断言必须在 withPanel 回调内完成（回调结束窗口即关闭）。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { withPanel, tick } from "./panel-helper.mjs";

const BUNDLE = new URL("../desktop/renderer/practice-editor.bundle.js", import.meta.url);

function injectBundle(window) {
  assert.ok(existsSync(BUNDLE), "缺少 practice-editor.bundle.js——先跑 npm run build:practice-editor");
  window.eval(readFileSync(BUNDLE, "utf8"));
  assert.ok(window.PracticeEditor?.create, "产物应暴露 window.PracticeEditor.create");
}

test("产物可用时：代码轮挂载 CodeMirror（.cm-editor），textarea/行号隐藏，语音按钮隐藏", async () => {
  await withPanel(async ({ window, kanban }) => {
    injectBundle(window);
    kanban.invStart = async () => ({
      ok: true, session: { round: 1, roundType: "手写轮" },
      question: "手写一个防抖函数", answerMode: "code", dimension: "代码", criteria: "c", boundary: "b",
    });
    window.document.getElementById("iv-start").click();
    await tick(120); // 等 loadPracticeEditor 注入/解析产物 + EditorView 挂载
    assert.ok(window.document.querySelector("#iv-editor .cm-editor"), "code 模式应挂出 CodeMirror（.cm-editor）");
    assert.equal(window.document.getElementById("iv-answer").style.display, "none", "textarea 应隐藏（改由 CM 提供编辑面）");
    assert.equal(window.document.getElementById("iv-gutter").style.display, "none", "手搓行号槽应隐藏（CM 自带行号）");
    assert.equal(window.document.getElementById("iv-mic").style.display, "none", "代码轮仍应隐藏语音按钮");
  });
});

test("产物可用时：提交仍读 #iv-answer（onChange 同步契约，语音/代码共用入口）", async () => {
  await withPanel(async ({ window, kanban }) => {
    injectBundle(window);
    kanban.invStart = async () => ({
      ok: true, session: { round: 1, roundType: "手写轮" },
      question: "手写一个防抖函数", answerMode: "code", dimension: "代码", criteria: "c", boundary: "b",
    });
    window.document.getElementById("iv-start").click();
    await tick(120);
    let answered = null;
    kanban.invAnswer = async (a) => { answered = a; return {
      ok: true, finished: false, scores: { tech: 80, expr: 70, depth: 60, edge: 50, reflect: 40 }, total: 60,
      comment: "ok", question: "下一问", roundType: "八股轮", dimension: "原理", answerMode: "text",
    }; };
    window.document.getElementById("iv-answer").value = "function debounce() {}";
    window.document.getElementById("iv-send").click();
    await tick(60);
    assert.equal(answered, "function debounce() {}", "提交链路仍应通过 #iv-answer 取值（与语音/文本轮同一入口）");
  });
});

test("产物可用时：下一轮切回 text → 销毁 CodeMirror、textarea/行号恢复可见（不泄漏）", async () => {
  await withPanel(async ({ window, kanban }) => {
    injectBundle(window);
    kanban.invStart = async () => ({
      ok: true, session: { round: 1, roundType: "手写轮" },
      question: "手写防抖", answerMode: "code", dimension: "代码", criteria: "c", boundary: "b",
    });
    window.document.getElementById("iv-start").click();
    await tick(120);
    assert.ok(window.document.querySelector("#iv-editor .cm-editor"), "先确认已挂载");
    window.setIvAnswerMode("text"); // 等价于后端下一问返回 answerMode: text
    await tick(60);
    assert.equal(window.document.querySelector("#iv-editor .cm-editor"), null, "切走后应销毁 CodeMirror 实例");
    assert.notEqual(window.document.getElementById("iv-answer").style.display, "none", "textarea 应恢复可见");
    assert.notEqual(window.document.getElementById("iv-gutter").style.display, "none", "行号槽应恢复");
  });
});

test("产物缺失时：代码轮保持原 textarea 行为（兜底不依赖新产物，既有测试语义不变）", async () => {
  await withPanel(async ({ window, kanban }) => {
    kanban.invStart = async () => ({
      ok: true, session: { round: 1, roundType: "手写轮" },
      question: "手写防抖", answerMode: "code", dimension: "代码", criteria: "c", boundary: "b",
    });
    window.document.getElementById("iv-start").click();
    await tick(200); // 兜底路径：loadPracticeEditor 最长 1.5s 后 resolve(null)，这里只需确认未挂 CM
    assert.equal(window.document.querySelector("#iv-editor .cm-editor"), null, "无产物时不应出现 CodeMirror");
    assert.notEqual(window.document.getElementById("iv-answer").style.display, "none", "textarea 应保持可用");
    assert.ok(window.document.getElementById("iv-answer").getAttribute("placeholder").includes("写代码作答"), "代码轮 placeholder 不变");
  });
});
