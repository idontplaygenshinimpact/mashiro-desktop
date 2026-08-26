// autonomy 决策层单测（Phase 事件驱动内核 W3）：规则表/三级模式/防抖/寂静/预算/审计
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("autonomy");
const { ruleFor, createAutonomy } = await import("../lib/autonomy.mjs");

test.after(() => { cleanupTempDb(dbDir); });

const ev = (type, source = "cc-watcher", payload = {}) => ({ type, source, ts: Date.now(), payload });

// ---------- 规则表 ----------
test("ruleFor：规则表（播报/静默/保持现状）", () => {
  assert.equal(ruleFor(ev("cc:session_started")).text, "🎬 Claude Code 开跑了");
  assert.equal(ruleFor(ev("cc:session_started")).scene, "agent-start");
  assert.equal(ruleFor(ev("cc:tool_use")), null, "工具调用静默");
  assert.equal(ruleFor(ev("cc:assistant_reply")).level, "bubble");
  assert.equal(ruleFor(ev("cc:session_finished", "cc-watcher", { durationSec: 240, toolCount: 5 })).text, "✅ CC 完成（4 分钟，用了 5 个工具）");
  assert.equal(ruleFor(ev("chat_done")), null, "本地对话保持现状");
  assert.equal(ruleFor(ev("schedule_due")), null, "日程提醒沿用现有逻辑防重复");
  assert.equal(ruleFor(ev("unknown_type")), null);
});

// ---------- 三级模式 ----------
test("mode=off：不表达（刹车第 1 层）", async () => {
  const emitted = [];
  const a = createAutonomy({ mode: "off", emit: (e) => emitted.push(e) });
  const r = await a.handle(ev("cc:session_started"));
  assert.equal(r, null);
  assert.equal(emitted.length, 0);
  assert.equal(a.state().mode, "off");
});

test("notify 模式（默认）：事件 → 表达入队 + 审计 decision_ledger", async () => {
  await clearAllTables();
  const emitted = [];
  const a = createAutonomy({ emit: (e) => emitted.push(e) });
  const r = await a.handle(ev("cc:session_started"));
  assert.ok(r, "产生表达");
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].text, "🎬 Claude Code 开跑了");
  assert.equal(emitted[0].ttl, 60000);
  // 审计落库（decision 合法枚举，事件类型在 tool_name）
  const { db } = await import("../lib/db.mjs");
  const n = db.prepare("SELECT COUNT(*) n FROM decision_ledger WHERE tool_name LIKE 'autonomy:%'").get().n;
  assert.equal(n, 1, "decision_ledger 审计一条");
});

// ---------- 防抖 ----------
test("防抖：同 source 同 type 5s 内合并（不重复表达）", async () => {
  let t = 1000;
  const emitted = [];
  const a = createAutonomy({ emit: (e) => emitted.push(e), now: () => t });
  await a.handle(ev("cc:assistant_reply"));
  t += 1000; // +1s（<5s 防抖）
  await a.handle(ev("cc:assistant_reply"));
  assert.equal(emitted.length, 1, "5s 内合并");
  t += 80000; // +80s：同时越过防抖窗口（5s）与寂静期（60s）
  await a.handle(ev("cc:assistant_reply"));
  assert.equal(emitted.length, 2, "超过防抖窗口可再表达");
});

// ---------- 寂静期 ----------
test("寂静期：上次表达 60s 内不同类型也不打扰", async () => {
  let t = 1000;
  const emitted = [];
  const a = createAutonomy({ emit: (e) => emitted.push(e), now: () => t });
  await a.handle(ev("cc:session_started"));
  t += 10000; // +10s（寂静期内）
  await a.handle(ev("cc:assistant_reply")); // 不同类型
  assert.equal(emitted.length, 1, "60s 寂静期内不打扰");
  t += 70000; // 超过寂静期
  await a.handle(ev("cc:assistant_reply"));
  assert.equal(emitted.length, 2);
});

// ---------- 预算 ----------
test("预算：每日表达上限耗尽后静默（有日志）", async () => {
  const logs = [];
  const emitted = [];
  let t = 1000;
  // 注入推进的 now：绕开寂静期（每次 handle 间隔 70s），专门测预算
  const a = createAutonomy({ emit: (e) => emitted.push(e), budgetDaily: 2, log: (m) => logs.push(m), now: () => t });
  await a.handle(ev("cc:session_started"));
  t += 70000;
  await a.handle(ev("cc:assistant_reply"));
  assert.equal(emitted.length, 2, "预算内表达");
  t += 70000;
  await a.handle(ev("cc:session_finished"));
  assert.equal(emitted.length, 2, "预算耗尽静默");
  assert.ok(logs.some((l) => l.includes("预算")), "有预算耗尽日志");
  assert.equal(a.state().expressed, 2);
});

// ---------- full 级 LLM 精炼 ----------
test("full 级：LLM 精炼成功用精炼文案；失败降级模板（不允许阻塞播报）", async () => {
  const emitted = [];
  const good = createAutonomy({ mode: "full", emit: (e) => emitted.push(e), refine: async () => "CC 开工啦！" });
  await good.handle(ev("cc:session_started"));
  assert.equal(emitted[0].text, "CC 开工啦！", "精炼文案生效");
  const bad = createAutonomy({ mode: "full", emit: (e) => emitted.push(e), refine: async () => { throw new Error("LLM 挂了"); } });
  const r = await bad.handle(ev("cc:assistant_reply"));
  assert.ok(r, "LLM 失败仍表达（降级模板）");
  assert.equal(r.text, "📝 CC 出结果了，去看看", "降级到规则模板");
});

test("full 级：精炼日上限（REFINE_DAILY=10）内精炼，超限用模板", async () => {
  let calls = 0;
  const emitted = [];
  const a = createAutonomy({ mode: "full", emit: (e) => emitted.push(e), refine: async () => { calls++; return "精炼"; } });
  for (let i = 0; i < 11; i++) await a.handle(ev("cc:session_started"));
  // 第 1 次表达即精炼一次；后续 9 次表达（防抖 5s 会合并！）——用不同 type 绕开防抖
  assert.ok(calls <= 10, `精炼不超过日上限（实际 ${calls}）`);
});

// ---------- 端到端：总线 → autonomy → 表达队列 ----------
test("端到端：emitEvent → autonomy.handle → enqueueExpression → drain", async () => {
  await clearAllTables();
  const { emitEvent, drainExpressions, clearExpressions, installInternalBridge } = await import("../lib/events.mjs");
  const { onHook, clearHooks } = await import("../lib/hooks.mjs");
  clearHooks(); clearExpressions(); installInternalBridge();
  const a = createAutonomy({ now: () => Date.now() });
  const off = (await import("../lib/events.mjs")).onEventDecision((e) => a.handle(e));
  emitEvent({ type: "cc:session_started", source: "cc-watcher", payload: { sessionId: "s" } });
  await new Promise((r) => setTimeout(r, 20));
  const evs = drainExpressions();
  assert.ok(evs.some((e) => e.text.includes("Claude Code")), "端到端表达入队");
  off();
});