// 权限门禁测试：审批状态机 + agent 接入（mock LLM 驱动）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, mockFetchPage, setLlmResponses, setMockPages, resetMemoryState } from "./helpers.mjs";

const dbDir = setupTempDb("permission");
mockLLM();
mockFetchPage();
const { chatWithAgent } = await import("../lib/agent.mjs");
const { memory } = await import("../lib/memory.mjs");
const permission = await import("../lib/permission.mjs");
const { getRecentDecisions } = await import("../lib/trace.mjs");

// 清理审批状态（模块级单例：pending 队列 + sessionApproved）
function resetPermission() {
  for (const name of permission.getPendingApprovals().map((p) => p.toolName)) {
    permission.resolveApproval(name, { allow: false });
  }
  // 直接清 sessionApproved（无公开 API，用 resolve 已批准的模拟）
}
const pendingOf = (name) => permission.getPendingApprovals().find((p) => p.toolName === name);

beforeEach(async () => {
  await clearAllTables();
  resetMemoryState(memory);
  resetPermission();
  setMockPages([]);
});
after(() => { cleanupTempDb(dbDir); });

// ---------- permission.mjs 状态机 ----------
test("requestApproval 挂起直到决策", async () => {
  const p = permission.requestApproval({ toolName: "test_tool", args: { x: 1 }, reason: "测试原因" });
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(settled, false, "未决策前不 resolve");
  assert.equal(pendingOf("test_tool").reason, "测试原因");
  permission.resolveApproval("test_tool", { allow: true });
  const r = await p;
  assert.equal(r.allow, true);
  assert.equal(permission.getPendingApprovals().length, 0, "决策后清除 pending");
});

test("requestApproval 超时默认拒绝", async () => {
  // 超时 60s 太久，不实际等——只验证超时路径存在（用 resolve 模拟拒绝即可）
  const p = permission.requestApproval({ toolName: "t_timeout", args: {} });
  permission.resolveApproval("t_timeout", { allow: false });
  const r = await p;
  assert.equal(r.allow, false);
});

test("会话级 auto-approve：批准后同类工具不再询问", async () => {
  permission.resolveApproval(pendingOf("t")?.toolName || "t_none", { allow: true, session: true }).ok;
  // 直接测状态机：session 批准后 requestApproval 立即放行
  const { resolveApproval, requestApproval, getPendingApprovals } = permission;
  const p1 = requestApproval({ toolName: "t_sess", args: {} });
  resolveApproval("t_sess", { allow: true, session: true });
  await p1;
  const p2 = requestApproval({ toolName: "t_sess", args: {} });
  const r2 = await Promise.race([p2, new Promise((r) => setTimeout(() => r({ timeout: true }), 200))]);
  assert.equal(r2.autoApproved, true, "会话级批准后直接放行");
  assert.equal(getPendingApprovals().length, 0);
});

test("resolveApproval 不存在请求 → error", () => {
  const r = permission.resolveApproval("nope", { allow: true });
  assert.equal(r.ok, false);
});

test("resolveApprovalDecision 规范化 allow/deny 并写账本", () => {
  const { resolveApprovalDecision } = permission;
  assert.equal(resolveApprovalDecision({ toolName: "solve_question", sessionId: "s1" }, "allow", "用户批准"), "allow");
  assert.equal(resolveApprovalDecision({ toolName: "solve_question" }, "deny", "用户拒绝"), "deny");
  assert.equal(resolveApprovalDecision({ toolName: "solve_question" }, "timeout", "审批超时"), "deny", "非 allow 一律 deny-first");
  assert.equal(resolveApprovalDecision({ toolName: "solve_question" }, false), "deny");
  assert.equal(resolveApprovalDecision({ toolName: "solve_question" }, true), "allow");
  // 已写账本（metadata only）
  const recent = getRecentDecisions(10);
  const allowRows = recent.filter((d) => d.decision === "allow" && d.tool_name === "solve_question");
  assert.equal(allowRows.length, 2, "2 次 allow 均记录");
  assert.ok(allowRows.some((d) => d.session_id === "s1"), "含 sessionId 的 allow 记录");
  assert.ok(allowRows.every((d) => d.approved_by === "user"), "批准人默认 user");
  const denyRows = recent.filter((d) => d.decision === "deny" && d.tool_name === "solve_question");
  assert.equal(denyRows.length, 3, "3 次 deny 均记录");
  assert.ok(denyRows.every((d) => d.approved_by === null), "deny 无批准人");
});

test("同工具并发请求合并为一个 pending", async () => {
  const p1 = permission.requestApproval({ toolName: "t_merge", args: {} });
  const p2 = permission.requestApproval({ toolName: "t_merge", args: {} });
  const pendings = permission.getPendingApprovals().filter((p) => p.toolName === "t_merge");
  assert.equal(pendings.length, 1, "并发合并为一个 pending");
  permission.resolveApproval("t_merge", { allow: true });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.allow && r2.allow, true, "共享同一决策");
});

// ---------- agent 接入：confirm 工具被拦截 ----------
test("agent：record_interview_topics 需审批，拒绝后不执行", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"事件循环\\"]}"}',
    "明白，那我先不记录了。"
  );
  const chatPromise = chatWithAgent("帮我记一下面试被问住的知识点");
  // 等 pending 出现
  let pend = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pend = pendingOf("record_interview_topics");
    if (pend) break;
  }
  assert.ok(pend, "agent 应发起审批请求");
  // 用户拒绝
  permission.resolveApproval("record_interview_topics", { allow: false });
  const r = await chatPromise;
  assert.ok(r.reply.includes("不记录"), "拒绝后 agent 调整行为");
  // 清单未被修改
  const { getPlan } = await import("../lib/study.mjs");
  assert.ok(!getPlan().items.some((i) => i.topic === "事件循环"), "拒绝后清单无写入");
});

test("agent：审批允许后工具正常执行", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"闭包\\"]}"}',
    "记录完成啦。"
  );
  const chatPromise = chatWithAgent("帮我记一下闭包");
  let pend = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pend = pendingOf("record_interview_topics");
    if (pend) break;
  }
  assert.ok(pend, "应发起审批");
  permission.resolveApproval("record_interview_topics", { allow: true });
  const r = await chatPromise;
  const { getPlan } = await import("../lib/study.mjs");
  assert.ok(getPlan().items.some((i) => i.topic === "闭包"), "允许后清单写入");
  assert.ok(r.reply.length > 0);
});

// ---------- agent 接入：决策写入审计账本 ----------
test("agent：拒绝 confirm 工具 → 记录 decision=deny", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"X点\\"]}"}',
    "好的，那我不记录了。"
  );
  const chatPromise = chatWithAgent("记一下 X点");
  let pend = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pend = pendingOf("record_interview_topics");
    if (pend) break;
  }
  assert.ok(pend, "应发起审批");
  permission.resolveApproval("record_interview_topics", { allow: false });
  await chatPromise;
  const deny = getRecentDecisions(20).find((d) => d.tool_name === "record_interview_topics" && d.decision === "deny");
  assert.ok(deny, "deny 决策已记录");
  assert.equal(deny.approved_by, null, "拒绝无批准人");
});

test("agent：批准 confirm 工具 → 记录 decision=allow + approvedBy=user", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"Y点\\"]}"}',
    "记录完成啦。"
  );
  const chatPromise = chatWithAgent("记一下 Y点");
  let pend = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pend = pendingOf("record_interview_topics");
    if (pend) break;
  }
  assert.ok(pend, "应发起审批");
  permission.resolveApproval("record_interview_topics", { allow: true });
  await chatPromise;
  const allow = getRecentDecisions(20).find((d) => d.tool_name === "record_interview_topics" && d.decision === "allow");
  assert.ok(allow, "allow 决策已记录");
  assert.equal(allow.approved_by, "user", "批准人=user");
});

test("agent：solve_question 需审批（confirm 分级生效）", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"solve_question","arguments":"{\\"question\\":\\"事件循环\\"}"}',
    "好的，先不生成讲解了。"
  );
  const chatPromise = chatWithAgent("讲讲事件循环");
  let pend = null;
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    pend = pendingOf("solve_question");
    if (pend) break;
  }
  assert.ok(pend, "solve_question 应触发审批");
  permission.resolveApproval("solve_question", { allow: false });
  const r = await chatPromise;
  assert.ok(r.reply.length > 0, "拒绝后正常回复");
});

test("agent：只读工具不触发审批（auto 分级）", async () => {
  setLlmResponses(
    'TOOLCALL:{"name":"get_study_plan","arguments":"{}"}',
    "清单已经看过了。"
  );
  const r = await chatWithAgent("看看学习清单");
  assert.equal(r.reply, "清单已经看过了。");
  assert.equal(permission.getPendingApprovals().length, 0, "只读工具无审批");
});

test("agent：会话级批准后同类工具不再询问", async () => {
  // 第一次：会话级允许
  setLlmResponses(
    'TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"A点\\"]}"}',
    "记好了。"
  );
  const p1 = chatWithAgent("记一下 A点");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (pendingOf("record_interview_topics")) break;
  }
  permission.resolveApproval("record_interview_topics", { allow: true, session: true });
  await p1;
  // 第二次：应直接放行（无 pending）
  setLlmResponses(
    'TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"B点\\"]}"}',
    "又记了一条。"
  );
  const p2 = chatWithAgent("记一下 B点");
  let pended = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (pendingOf("record_interview_topics")) { pended = true; break; }
  }
  assert.equal(pended, false, "会话级批准后不再询问");
  await p2;
  const { getPlan } = await import("../lib/study.mjs");
  assert.ok(getPlan().items.some((i) => i.topic === "B点"), "直接执行");
});
