// 场景装配单测（Phase P1）：事件→场景匹配/优先级/兜底/切换幂等/状态持久化
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 场景状态文件指向项目 data/scene.json——测试通过临时目录注入：重写模块状态文件路径不可行，
// 用 matchScenario/resolveEvent 纯逻辑 + 场景切换状态断言（持久化在 widget 接线层验证）
const { SCENARIOS, matchScenario, resolveEvent, resetScenario, getCurrentScenario } = await import("../lib/scenarios.mjs");
const { clearExpressions } = await import("../lib/events.mjs");

const ev = (type, source = "test") => ({ type, source, ts: Date.now(), payload: {} });

test("SCENARIOS：声明结构完整（when 纯函数/skills 数组/default 兜底）", () => {
  assert.ok(SCENARIOS.length >= 4, "至少 interview/companion/study/default");
  const def = SCENARIOS.find((s) => s.id === "default");
  assert.ok(def, "default 场景存在");
  assert.equal(def.when({ type: "anything" }), true, "default 恒真");
  for (const s of SCENARIOS) {
    assert.equal(typeof s.when, "function", `${s.id} when 是函数`);
    assert.ok(Array.isArray(s.skills), `${s.id} skills 数组`);
  }
});

test("matchScenario：事件→场景（含优先级与 default 兜底）", () => {
  assert.equal(matchScenario(ev("interview:started")).id, "interview");
  assert.equal(matchScenario(ev("interview:answering")).id, "interview");
  assert.equal(matchScenario(ev("cc:session_started")).id, "companion");
  assert.equal(matchScenario(ev("cc:tool_use")).id, "companion");
  assert.equal(matchScenario(ev("study:opened")).id, "study");
  assert.equal(matchScenario(ev("chat_done")).id, "default", "未匹配 → default 兜底");
  assert.equal(matchScenario({ type: "unknown" }).id, "default");
  assert.equal(matchScenario(null).id, "default", "空事件不崩溃");
});

test("resolveEvent：切换返回 changed + 场景对象；同场景幂等（不重复切换）", () => {
  resetScenario();
  // 切到 interview
  const r1 = resolveEvent(ev("interview:started"));
  assert.equal(r1.changed, true);
  assert.equal(r1.scenario.id, "interview");
  // 同场景事件 → 不切换
  const r2 = resolveEvent(ev("interview:answering"));
  assert.equal(r2.changed, false, "同场景幂等");
  // 切到 companion（顺序：interview 事件不会命中 companion）
  const r3 = resolveEvent(ev("cc:session_started"));
  assert.equal(r3.changed, true);
  assert.equal(r3.scenario.id, "companion");
  // 回 default（显式收尾）
  const r4 = resetScenario();
  assert.equal(r4.changed, true);
  assert.equal(getCurrentScenario().id, "default");
  const r5 = resetScenario();
  assert.equal(r5.changed, false, "已 default 再 reset 幂等");
});

test("resolveEvent：场景技能子集正确（agent 按此加载）", () => {
  resetScenario();
  resolveEvent(ev("interview:started"));
  assert.deepEqual(getCurrentScenario().skills, ["interview-warmup", "resume-coach"]);
  resolveEvent(ev("cc:assistant_reply"));
  assert.deepEqual(getCurrentScenario().skills, ["company-intel", "tech-compare"]);
  resetScenario();
  assert.deepEqual(getCurrentScenario().skills, [], "default 不注入任何技能");
});

test("场景切换发 scene:switched 事件（总线可消费，非播报动作）", async () => {
  resetScenario();
  const { onEventDecision } = await import("../lib/events.mjs");
  const got = [];
  const off = onEventDecision((e) => { if (e.type === "scene:switched") got.push(e.payload.scenario); });
  resolveEvent(ev("interview:started"));
  await new Promise((r) => setTimeout(r, 15));
  assert.deepEqual(got, ["interview"], "scene:switched 事件发出");
  // 同场景再触发不重复发
  resolveEvent(ev("interview:answering"));
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(got.length, 1, "同场景幂等不重复发");
  off();
});

// ---------- 端到端：场景切换 → agent prompt 只含场景技能（方案验收 §3） ----------
test("端到端：interview 场景下 agent prompt 含面试技能 hints、不含无关技能", async () => {
  resetScenario();
  const { mockLLM, setupTempDb, getLastMessages } = await import("./helpers.mjs");
  mockLLM(); // 对话用 mock，不调真实 LLM
  const dbDir = setupTempDb("scenarios-e2e");
  const { setActiveSkillSet, getActiveSkillSet } = await import("../lib/skills.mjs");
  const { onEventDecision, emitEvent } = await import("../lib/events.mjs");
  const { resolveEvent: resolve } = await import("../lib/scenarios.mjs");
  try {
    // 模拟 widget 接线：事件 → 场景解析 → 技能激活（scene:switched 跳过解析防递归）
    const off = onEventDecision((e) => {
      if (e.type === "scene:switched" || e.source === "scenarios") return;
      const { changed, scenario } = resolve(e);
      if (changed) setActiveSkillSet(scenario.skills);
    });
    // 发面试开始事件（等价 startInterview 的 emitEvent）
    emitEvent({ type: "interview:started", source: "interview", payload: {} });
    await new Promise((r) => setTimeout(r, 15));
    assert.deepEqual(getActiveSkillSet(), ["interview-warmup", "resume-coach"], "场景激活面试技能集");
    // agent 对话：prompt 注入激活集 hints（不含无关技能）
    const { chatWithAgent } = await import("../lib/agent.mjs");
    await chatWithAgent("开始模拟面试吧", [], () => {});
    const system = getLastMessages()[0]?.content || "";
    assert.ok(system.includes("interview-warmup"), "prompt 含面试技能 hints");
    assert.ok(system.includes("resume-coach"), "prompt 含简历教练 hints");
    assert.ok(!system.includes("company-intel"), "prompt 不含无关技能");
    off();
  } finally {
    setActiveSkillSet(null);
    resetScenario();
  }
});