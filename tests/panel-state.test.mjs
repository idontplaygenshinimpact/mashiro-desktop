// 原生面板状态收敛工单：panel-state.js 状态对象 + 事件总线测试
// 覆盖：resetStudyDetail 复位路径（代际递增/streaming 复位/事件通知）、interviewTimer 生命周期
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "desktop", "renderer");
const src = readFileSync(path.join(renderer, "panel-state.js"), "utf8");

function boot() {
  // 注意：jsdom eval 的全局 window 绑定依赖 origin + runScripts——file:// opaque origin 无 window（挂 globalThis），
  // 必须用 http origin + outside-only（与 panel-helper 一致）——panel-state.js 的 IIFE 才能挂到 window.panelState
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://127.0.0.1:8899/panel.html", runScripts: "outside-only" });
  const { window } = dom;
  window.eval(src);
  return window;
}

test("resetStudyDetail：代际递增 + streaming/generatingId/currentId 复位 + 事件通知", () => {
  const window = boot();
  const ps = window.panelState;
  // 模拟流式进行中状态
  ps.studyDetailState.gen = 3;
  ps.studyDetailState.streaming = true;
  ps.studyDetailState.generatingId = "item-1";
  ps.studyDetailState.currentId = "item-1";
  let resetEvent = null;
  ps.onPanelEvent("studyDetail:reset", (e) => { resetEvent = e; });
  ps.resetStudyDetail();
  assert.equal(ps.studyDetailState.gen, 4, "代际递增（过期流丢弃）");
  assert.equal(ps.studyDetailState.streaming, false, "streaming 复位");
  assert.equal(ps.studyDetailState.generatingId, null, "generatingId 复位");
  assert.equal(ps.studyDetailState.currentId, null, "currentId 复位");
  assert.ok(resetEvent && resetEvent.gen === 4, "复位事件通知（跨模块通信走事件总线）");
});

test("interviewTimer：start 启动计时 / stop 停止 / reset 清零", async () => {
  const window = boot();
  const ps = window.panelState;
  ps.interviewTimer("start");
  assert.ok(ps.interviewState.timer, "start 后 timer 存在");
  assert.equal(ps.interviewState.roundSeconds, 0, "start 清零");
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(ps.interviewState.roundSeconds >= 1, "计时推进");
  ps.interviewTimer("stop");
  const stopped = ps.interviewState.roundSeconds;
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(ps.interviewState.roundSeconds, stopped, "stop 后不再推进");
  ps.interviewTimer("reset");
  assert.equal(ps.interviewState.roundSeconds, 0, "reset 清零");
  assert.equal(ps.interviewState.timer, null, "reset 后 timer 清除");
});

test("事件总线：订阅/发布/取消（订阅者异常隔离）", () => {
  const window = boot();
  const ps = window.panelState;
  const got = [];
  const off1 = ps.onPanelEvent("test:ev", (p) => got.push(p));
  ps.onPanelEvent("test:ev", () => { throw new Error("boom"); }); // 异常订阅者
  ps.onPanelEvent("test:ev", (p) => got.push(p + "-2"));
  ps.emitPanelEvent("test:ev", "x");
  assert.deepEqual(got, ["x", "x-2"], "正常订阅者都收到（异常隔离）");
  off1();
  ps.emitPanelEvent("test:ev", "y");
  assert.deepEqual(got, ["x", "x-2", "y-2"], "取消后不再收到");
});

after(() => { /* jsdom 无残留 */ });
