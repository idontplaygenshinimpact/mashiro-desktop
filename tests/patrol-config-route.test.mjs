// 巡检设置回填回归护栏（闭环清查）：GET /api/patrol-config 必须带 ok
// 背景：面板是 `if (r?.ok) { 回填开关/间隔/预算 }`，而路由原先不返回 ok → 整个巡检设置区从不回填，
// 输入框显示占位假值（100000），用户一保存就把假值写成真实预算；开关/间隔与后端真实态也不一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../lib/routes/router.mjs";
import { setupTempDb, mockLLM } from "./helpers.mjs";

setupTempDb("patrol-config-route");
mockLLM();

const { registerCoreRoutes } = await import("../lib/routes/core.mjs");

function mockRes() {
  const chunks = [];
  return {
    chunks, destroyed: false, writableEnded: false, status: 0,
    writeHead(code) { this.status = code; return this; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; },
    on() {},
  };
}

test("GET /api/patrol-config 返回 ok:true + 四个面板需要的字段", async () => {
  const router = createRouter();
  registerCoreRoutes(router, {
    runtime: {
      patrolGetConfig: () => ({ enabled: true, intervalMin: 30, avoidPeak: false, lastRun: 0, nextRun: 0 }),
      patrolGetBudget: () => 50000,
      patrolGetUsed: () => 12,
    },
  });
  const entry = router.resolve("/api/patrol-config", "GET");
  assert.ok(entry, "路由已注册");
  const res = mockRes();
  await entry.fn({ method: "GET", url: "/api/patrol-config", headers: {}, on(ev, fn) { if (ev === "end") setImmediate(fn); return this; }, destroy() {} }, res, new URL("/api/patrol-config", "http://x"));
  const j = JSON.parse(res.chunks.join(""));
  assert.equal(res.status, 200);
  assert.equal(j.ok, true, "必须带 ok（否则面板整块回填被跳过）");
  assert.equal(j.enabled, true);
  assert.equal(j.intervalMin, 30);
  assert.equal(j.avoidPeak, false);
  assert.equal(j.dailyTokenBudget, 50000);
  assert.equal(j.usedToday, 12);
});
