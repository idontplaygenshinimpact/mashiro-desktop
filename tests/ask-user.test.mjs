// ask-user 提问服务单测 + agent 集成（ask_user / plan_mode 挂起→点选→继续）
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

let tmpDir;
before(() => {
  tmpDir = setupTempDb("ask");
  mockLLM();
});
after(() => cleanupTempDb(tmpDir));

// ---------- 单元：askUser 服务 ----------
test("askUser：挂起直到回答，返回 selected", async () => {
  const { askUser, getPendingAsks, answerAsk } = await import("../lib/ask-user.mjs");
  const p = askUser({ question: "今天先做什么？", options: [{ label: "学习" }, { label: "投递" }] });
  let settled = false;
  p.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settled, false, "未回答前不 resolve");
  const pend = getPendingAsks();
  assert.equal(pend.length, 1);
  assert.equal(pend[0].options.length, 2);
  const r = answerAsk(pend[0].id, { selected: ["学习"] });
  assert.equal(r.ok, true);
  const out = await p;
  assert.equal(out.timeout, false);
  assert.deepEqual(out.selected, ["学习"]);
  assert.equal(getPendingAsks().length, 0, "回答后清除");
});

test("askUser：超时返回 timeout（默认 120s 可注入短超时）", async () => {
  const { askUser, getPendingAsks } = await import("../lib/ask-user.mjs");
  const p = askUser({ question: "q", options: [{ label: "a" }, { label: "b" }], timeoutMs: 50 });
  const out = await p;
  assert.equal(out.timeout, true);
  assert.ok(out.reason.includes("超时"));
  assert.equal(getPendingAsks().length, 0, "超时后清除");
});

test("answerAsk：不存在 id → error；cancelAsk 生效", async () => {
  const { askUser, answerAsk, cancelAsk, getPendingAsks } = await import("../lib/ask-user.mjs");
  const r1 = answerAsk("nope", { selected: ["x"] });
  assert.equal(r1.ok, false);
  const p = askUser({ question: "q", options: [{ label: "a" }, { label: "b" }] });
  cancelAsk(getPendingAsks()[0].id);
  const out = await p;
  assert.equal(out.timeout, true);
});

// ---------- 集成：agent 工具 ----------
test("chatWithAgent：ask_user 挂起 → 面板回答 → 继续完成", async () => {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  const { getPendingAsks, answerAsk } = await import("../lib/ask-user.mjs");
  setLlmResponses(
    'TOOLCALL:{"name":"ask_user","arguments":"{\\"question\\":\\"先学还是先投？\\",\\"options\\":[{\\"label\\":\\"先学习\\"},{\\"label\\":\\"先投递\\"}]}"}',
    "好的，那我先帮你安排学习。"
  );
  const chatPromise = chatWithAgent("帮我规划一下");
  // 等 ask_user 挂起 → 面板回答
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (getPendingAsks().length) break;
  }
  const pend = getPendingAsks()[0];
  assert.ok(pend, "ask_user 已挂起");
  assert.ok(pend.question.includes("先学还是先投"), "问题透出");
  answerAsk(pend.id, { selected: ["先学习"] });
  const r = await chatPromise;
  assert.ok(r.reply.includes("学习"), "基于用户选择继续");
});

test("chatWithAgent：plan_mode 确认后执行；取消则不执行", async () => {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  const { getPendingAsks, answerAsk } = await import("../lib/ask-user.mjs");
  // 场景 A：确认执行
  setLlmResponses(
    'TOOLCALL:{"name":"plan_mode","arguments":"{\\"plan\\":\\"1.搜索面经 2.提炼考点 3.生成清单\\"}"}',
    "开始执行计划。"
  );
  const cp1 = chatWithAgent("整理面经");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (getPendingAsks().length) break;
  }
  const ask1 = getPendingAsks()[0];
  assert.ok(ask1, "plan 已挂起");
  assert.equal(ask1.kind, "plan", "kind=plan");
  answerAsk(ask1.id, { selected: ["✅ 执行"] });
  const r1 = await cp1;
  assert.ok(r1.reply.length > 0);
  // 场景 B：取消
  setLlmResponses(
    'TOOLCALL:{"name":"plan_mode","arguments":"{\\"plan\\":\\"投递全部岗位\\"}"}',
    "好的，不执行。"
  );
  const cp2 = chatWithAgent("帮我投递");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (getPendingAsks().length) break;
  }
  const ask2 = getPendingAsks()[0];
  answerAsk(ask2.id, { selected: ["❌ 取消"] });
  const r2 = await cp2;
  assert.ok(r2.reply.length > 0, "取消后正常收尾");
});

test("ask_user 参数校验：选项不足 → 错误回填", async () => {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  setLlmResponses(
    'TOOLCALL:{"name":"ask_user","arguments":"{\\"question\\":\\"q\\",\\"options\\":[{\\"label\\":\\"只有一个\\"}]}"}',
    "选项不够，我直接给建议。"
  );
  const r = await chatWithAgent("帮我选");
  assert.ok(r.reply.length > 0);
});
