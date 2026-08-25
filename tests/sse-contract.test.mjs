// SSE 契约测试（Phase 2 §3.6）：事件序列化 → 反解 → safeParse；"字段改名"用例证明契约拦漂移。
// 漂移场景：服务端改事件字段名（如 delta→chunk），两端硬编码的消费者会拿到 undefined——契约在此兜底。
import { test } from "node:test";
import assert from "node:assert/strict";

const EVENTS = [
  { type: "start" },
  { type: "delta", delta: "逐步输出内容" },
  { type: "progress", done: 3, total: 10, title: "收集题目" },
  { type: "done", reply: "答案", saved: true, filePath: "/x.md" },
  { type: "done", history: [], clusterName: "综合簇" },
  { type: "cache", hit: true, similarity: 0.9, cachedQuestion: "追问" },
  { type: "error", error: "生成失败" },
];

test("StudyStreamEvent：全部合法事件一次往返（序列化→反解→safeParse）通过", async () => {
  const { StudyStreamEvent } = await import("../lib/contracts/sse.mjs");
  for (const ev of EVENTS) {
    const wire = `data: ${JSON.stringify(ev)}\n\n`;
    const parsed = JSON.parse(wire.slice(6).trim());
    const r = StudyStreamEvent.safeParse(parsed);
    assert.ok(r.success, `事件 ${ev.type} 往返后校验通过`);
  }
});

test("字段改名漂移 → 校验拦截（契约保护）", async () => {
  const { StudyStreamEvent } = await import("../lib/contracts/sse.mjs");
  // 模拟服务端把 delta 字段改名成 chunk（历史客户端读 delta 会 undefined）
  const drift = { type: "delta", chunk: "改名字段" };
  assert.ok(!StudyStreamEvent.safeParse(drift).success, "改名后 delta 缺失 → 拒绝");
  // 模拟 type 拼错
  assert.ok(!StudyStreamEvent.safeParse({ type: "deno", delta: "x" }).success, "type 拼错 → 拒绝");
  // 未声明的事件类型（如漏定义的新事件）→ 拒绝（契约外事件需要显式加入 union）
  assert.ok(!StudyStreamEvent.safeParse({ type: "mystery", x: 1 }).success, "未知 type → 拒绝");
  // 字段类型错
  assert.ok(!StudyStreamEvent.safeParse({ type: "progress", done: "3", total: 10, title: "t" }).success, "done 应为数字 → 拒绝");
});

test("createSSEPush strict 模式：漂移事件触发 console.error（开发期暴露）", async () => {
  const { createSSEPush } = await import("../lib/routes/contract.mjs");
  const { StudyStreamEvent } = await import("../lib/contracts/sse.mjs");
  const writes = [];
  const res = { destroyed: false, writableEnded: false, write(s) { writes.push(s); } };
  const errors = [];
  const origErr = console.error;
  console.error = (...a) => errors.push(a.map((x) => String(x)).join(" "));
  try {
    const { push } = createSSEPush(res, { eventSchema: StudyStreamEvent, strict: true });
    push({ type: "start" }); // 合法
    push({ type: "delta", chunk: "漂移字段" }); // 非法（delta 缺）
    assert.ok(errors.some((e) => e.includes("[sse]")), "strict 下漂移事件 console.error");
  } finally {
    console.error = origErr;
  }
  // 非 stric 环境：零开销，不报错（默认）
  const writes2 = [];
  const { push: p2 } = createSSEPush({ destroyed: false, writableEnded: false, write(s) { writes2.push(s); } }, { eventSchema: StudyStreamEvent, strict: false });
  p2({ type: "delta", chunk: "x" });
  assert.equal(writes2.length, 1, "strict 关闭时照常透传（零拦截开销）");
});

test("ChatStreamEvent：工具/agent 事件合法通过", async () => {
  const { ChatStreamEvent } = await import("../lib/contracts/sse.mjs");
  for (const ev of [
    { type: "tool_start", name: "search" },
    { type: "tool_done", name: "search", output: "ok" },
    { type: "tool_error", name: "search", error: "失败" },
    { type: "agent_done", reply: "答", rounds: 3, interrupted: false, voice: "" },
  ]) {
    assert.ok(ChatStreamEvent.safeParse(ev).success, `chat 事件 ${ev.type} 通过`);
  }
});
