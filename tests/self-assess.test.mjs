// 薄弱点闭环工单任务 1：知识树三档自评摸底测试
// 覆盖：自评"不会"写入薄弱点+入清单 / "一般"写掌握度 / "熟悉"不采信（不对称采信）/ 幂等
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, resetMemoryState } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

const dbDir = setupTempDb("self-assess");
const { registerKbRoutes } = await import("../plugins/job-hunter/routes/kb.mjs");
const { memory } = await import("../lib/memory.mjs");
const { db } = await import("../lib/db.mjs");
const { getPlan } = await import("../lib/study.mjs");
const { getMastery, matchKp } = await import("../lib/knowledge.ts");

const router = createRouter();
registerKbRoutes(router, { getCorsOrigin: () => "*" });

function mockRes() {
  const chunks = [];
  return {
    chunks,
    destroyed: false,
    writableEnded: false,
    status: 200,
    writeHead(code) { this.status = code; },
    write(c) { chunks.push(String(c)); return true; },
    end(c) { if (c) chunks.push(String(c)); this.writableEnded = true; },
    on() {},
  };
}
function mockReq(url, body = "") {
  const listeners = {};
  return {
    url, method: "POST",
    on(ev, fn) { listeners[ev] = fn; },
    _emitBody() { if (listeners.data) listeners.data(Buffer.from(body)); if (listeners.end) listeners.end(); },
  };
}
async function postSelfAssess(assessments) {
  const req = mockReq("/api/self-assess", JSON.stringify({ assessments }));
  const res = mockRes();
  const handler = router.resolve("/api/self-assess", "POST").fn;
  await handler(req, res);
  req._emitBody();
  for (let i = 0; i < 50 && !res.writableEnded; i++) await new Promise((r) => setTimeout(r, 10));
  return JSON.parse(res.chunks.join(""));
}

beforeEach(async () => {
  await clearAllTables();
  resetMemoryState(memory);
});

test("自评「不会」→ weak_points 写入（origin=self_assess）+ 入学习清单", async () => {
  const r = await postSelfAssess([{ topic: "闭包与作用域", level: "weak" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.weakAdded, ["闭包与作用域"], "不会 → 建薄弱点");
  const weak = memory.getTrustedWeakPoints(100);
  const w = weak.find((x) => x.topic === "闭包与作用域");
  assert.ok(w, "薄弱点存在");
  assert.equal(w.origin, "self_assess", "origin=self_assess（可信级别同 owner）");
  assert.equal(w.failCount, 1, "自评 failCount 从 1 起（非答错累加）");
  // 入清单
  const plan = getPlan();
  assert.ok((plan.items || []).some((i) => i.topic === "闭包与作用域" && i.source === "自评摸底"), "清单有自评条目");
});

test("自评「一般」→ 仅写掌握度（映射 0.5），不建薄弱点", async () => {
  const r = await postSelfAssess([{ topic: "事件循环与微任务", level: "ok" }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.weakAdded, [], "一般不建薄弱点");
  assert.equal(memory.getTrustedWeakPoints(100).length, 0, "无薄弱点");
  const kpId = matchKp("事件循环与微任务");
  if (kpId) {
    const m = getMastery().find((k) => k.id === kpId);
    assert.equal(m.score, 50, "掌握度映射 0.5");
  }
});

test("自评「熟悉」→ 不建薄弱点（不对称采信——防 Dunning-Kruger 高估）", async () => {
  const r = await postSelfAssess([{ topic: "Promise 与异步", level: "familiar" }]);
  assert.equal(r.ok, true);
  assert.equal(memory.getTrustedWeakPoints(100).length, 0, "熟悉不采信");
  const plan = getPlan();
  assert.ok(!(plan.items || []).some((i) => i.topic === "Promise 与异步"), "熟悉不入清单");
});

test("幂等：重复自评同 topic → 不重复建薄弱点/清单", async () => {
  await postSelfAssess([{ topic: "闭包与作用域", level: "weak" }]);
  const r2 = await postSelfAssess([{ topic: "闭包与作用域", level: "weak" }]);
  assert.deepEqual(r2.weakAdded, [], "重复自评不重复建");
  assert.deepEqual(r2.skipped, ["闭包与作用域"], "已存在 → 跳过");
  const weak = memory.getTrustedWeakPoints(100).filter((w) => w.topic === "闭包与作用域");
  assert.equal(weak.length, 1, "薄弱点只有 1 条");
  const plan = getPlan();
  assert.equal((plan.items || []).filter((i) => i.topic === "闭包与作用域").length, 1, "清单只有 1 条");
});

test("摸底状态：提交后 self_assess_done 标记（下次不再弹引导）", async () => {
  const before = db.prepare("SELECT value FROM settings WHERE key='self_assess_done'").get();
  assert.equal(before, undefined, "初始未摸底");
  await postSelfAssess([{ topic: "闭包与作用域", level: "weak" }]);
  const after = db.prepare("SELECT value FROM settings WHERE key='self_assess_done'").get();
  assert.equal(after.value, "1", "提交后标记完成");
});

after(() => { cleanupTempDb(dbDir); });
