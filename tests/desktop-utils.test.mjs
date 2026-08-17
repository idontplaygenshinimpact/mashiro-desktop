// desktop/lib 模块单测（纵向拆分产物：window-state/restart 纯逻辑，无 electron 依赖）
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const { readWindowState, saveWindowState, scheduleSaveWindowState, isOnScreen } = await import("../desktop/lib/window-state.mjs");
const { rendererBundleStale } = await import("../desktop/lib/restart.mjs");

test("window-state：读写 + 损坏文件容错", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ws-"));
  const file = path.join(dir, "state.json");
  assert.deepEqual(readWindowState(file), {}, "无文件返回 {}");
  saveWindowState(file, { mascot: { x: 1, y: 2 }, panel: { x: 3, y: 4, width: 500, height: 700 } });
  const r = readWindowState(file);
  assert.equal(r.mascot.x, 1);
  assert.equal(r.panel.width, 500);
  writeFileSync(file, "not-json{{", "utf8");
  assert.deepEqual(readWindowState(file), {}, "损坏 JSON 返回 {}");
  rmSync(dir, { recursive: true, force: true });
});

test("window-state：scheduleSaveWindowState 防抖（窗口期内多次调用只写一次最新状态）", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ws-"));
  const file = path.join(dir, "state.json");
  // 外部状态对象（模拟 main.mjs 的 mascotState/panelState let 变量）
  let state = { mascot: { x: 0 } };
  const sched = scheduleSaveWindowState(file, () => state, 100);
  state = { mascot: { x: 1 } }; sched();
  state = { mascot: { x: 2 } }; sched();
  state = { mascot: { x: 3 } }; sched();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(readWindowState(file).mascot.x, 3, "防抖合并：只写最后一次状态");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(readWindowState(file).mascot.x, 3, "不再重复写");
  rmSync(dir, { recursive: true, force: true });
});

test("window-state：isOnScreen 屏内校验（主体至少露出 40px）", () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(isOnScreen(wa, 100, 100, 500, 700), true, "正常位置");
  assert.equal(isOnScreen(wa, -1000, -1000, 500, 700), false, "完全屏幕外");
  assert.equal(isOnScreen(wa, 1900, 100, 500, 700), false, "右侧几乎全出屏");
  assert.equal(isOnScreen(wa, -30, 100, 500, 700), true, "左侧裁 30px 但主体（470px）可见");
  assert.equal(isOnScreen(wa, -1800, 100, 500, 700), false, "左侧几乎全出屏");
  assert.equal(isOnScreen(null, 100, 100, 500, 700), false, "无 workArea 容错");
});

test("restart：rendererBundleStale 检测源码比 bundle 新", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rb-"));
  const t = Date.now();
  writeFileSync(path.join(dir, "app.bundle.js"), "bundle", "utf8");
  utimesSync(path.join(dir, "app.bundle.js"), new Date(t), new Date(t));
  // bundle 最新 → 不 stale
  writeFileSync(path.join(dir, "app.js"), "src", "utf8");
  utimesSync(path.join(dir, "app.js"), new Date(t - 1000), new Date(t - 1000));
  assert.equal(rendererBundleStale(dir, ["app.js", "index.html", "style.css"]), false, "源码比 bundle 旧");
  // 源码比 bundle 新 → stale
  utimesSync(path.join(dir, "app.js"), new Date(t + 1000), new Date(t + 1000));
  assert.equal(rendererBundleStale(dir, ["app.js", "index.html", "style.css"]), true, "源码比 bundle 新");
  // bundle 缺失 → stale
  rmSync(path.join(dir, "app.bundle.js"));
  assert.equal(rendererBundleStale(dir, ["app.js"]), true, "无 bundle 视为过期");
  rmSync(dir, { recursive: true, force: true });
});
