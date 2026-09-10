// nowcoder-surf 技能测试（牛客逛完强化方案任务 2）：决策循环——价值判断/归档/线索/逛完汇报
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("nowcoder-surf");
mockLLM();
const { tools } = await import("../skills/nowcoder-surf/skill.mjs");
const surfNowcoder = tools[0].run; // 工具 run（surf_nowcoder）
const { getPlan } = await import("../lib/study.mjs");

function nowcoderHtml({ page, totalPage, moments }) {
  const items = moments.map((m) => `"contentId":"${m.id}","contentType":74,"title":"${m.title}","newTitle":"x","content":"${m.content}","newContent":"x"`).join(",");
  return `{"current":${page},"totalPage":${totalPage},"nickname":"测试牛友","authDisplayInfo":"前端工程师","moments":[${items}]}`;
}

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

test("surf_nowcoder：逛完汇报——价值判断/高价值归档/线索/逛完判定", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => nowcoderHtml({ page: 1, totalPage: 1, moments: [
    { id: "111", title: "字节前端一面", content: "事件循环\\u002F宏任务微任务" },
    { id: "222", title: "手写防抖", content: "定时器方案" },
    { id: "333", title: "日常吐槽", content: "今天好累" },
  ] }) });
  // LLM 价值判断：111 高（事件循环）、222 中（防抖）、333 无关 + 线索"字节"
  setLlmResponses(JSON.stringify([
    { i: 0, value: "高", topic: "事件循环", leads: ["字节"] },
    { i: 1, value: "中", topic: "手写防抖", leads: [] },
    { i: 2, value: "无关", topic: "", leads: [] },
  ]));
  try {
    const r = await surfNowcoder({ userId: "500303394", goal: "字节前端面经" });
    assert.equal(r.ok, true, "逛完成功");
    assert.ok(r.report.includes("高价值 1 篇已归档"), "高价值归档汇报");
    assert.ok(r.report.includes("线索：字节"), "线索提取汇报");
    // 高价值已进学习清单
    const plan = getPlan();
    assert.ok(plan.items.some((i) => i.topic === "事件循环"), "高价值归档学习清单");
  } finally { globalThis.fetch = origFetch; }
});

test("surf_nowcoder：LLM 判断失败 → 降级不丢内容（全部中价值）", async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => nowcoderHtml({ page: 1, totalPage: 1, moments: [
    { id: "111", title: "字节前端一面", content: "事件循环" },
  ] }) });
  setLlmResponses("乱码不是 JSON"); // LLM 判断失败
  try {
    const r = await surfNowcoder({ userId: "500303394" });
    assert.equal(r.ok, true, "降级不失败");
    assert.ok(r.report.includes("中价值 1 篇"), "降级为中价值（不丢内容）");
  } finally { globalThis.fetch = origFetch; }
});

// ---------- 薄弱点闭环工单任务 3：逛网薄弱点定向 ----------
test("任务3①：价值判断 prompt 注入薄弱点列表（逛网定向补弱）", async () => {
  const { memory } = await import("../lib/memory.mjs");
  const { resetMemoryState, getLastMessages } = await import("./helpers.mjs");
  resetMemoryState(memory);
  memory.addWeakPoint("事件循环", "复习答错", "agent", {});
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => nowcoderHtml({ page: 1, totalPage: 1, moments: [
    { id: "111", title: "字节前端一面", content: "事件循环" },
  ] }) });
  setLlmResponses(JSON.stringify([{ i: 0, value: "高", topic: "事件循环", leads: [] }]));
  try {
    await surfNowcoder({ userId: "500303394", goal: "字节前端面经" });
    const user = getLastMessages().map((m) => m.content).join("\n");
    assert.ok(user.includes("【用户薄弱点】"), "prompt 含薄弱点标记");
    assert.ok(user.includes("事件循环"), "薄弱点列表注入");
    assert.ok(user.includes("不涉及不降级"), "权重设计（不相关不扣分——不误杀新知识）");
  } finally { globalThis.fetch = origFetch; }
});

test("任务3②：薄弱点相关 → 归档标注「薄弱点定向」（优先补强）", async () => {
  const { memory } = await import("../lib/memory.mjs");
  const { resetMemoryState } = await import("./helpers.mjs");
  resetMemoryState(memory);
  memory.addWeakPoint("事件循环", "复习答错", "agent", {});
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => nowcoderHtml({ page: 1, totalPage: 1, moments: [
    { id: "111", title: "字节前端一面", content: "事件循环" },
  ] }) });
  setLlmResponses(JSON.stringify([{ i: 0, value: "高", topic: "事件循环", leads: [] }]));
  try {
    const r = await surfNowcoder({ userId: "500303394", goal: "字节前端面经" });
    assert.ok(r.report.includes("薄弱点定向 1 篇"), "汇报标注薄弱点定向");
    const plan = getPlan();
    const item = plan.items.find((i) => i.topic === "事件循环");
    assert.ok(item && String(item.why).includes("薄弱点定向"), "归档 why 标注薄弱点定向");
  } finally { globalThis.fetch = origFetch; }
});

test("任务3③：非薄弱点内容不被过滤（权重设计——不相关不扣分）", async () => {
  const { memory } = await import("../lib/memory.mjs");
  const { resetMemoryState } = await import("./helpers.mjs");
  resetMemoryState(memory);
  memory.addWeakPoint("事件循环", "复习答错", "agent", {});
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => nowcoderHtml({ page: 1, totalPage: 1, moments: [
    { id: "111", title: "字节前端一面", content: "事件循环" },
    { id: "222", title: "手写防抖", content: "定时器方案" },
  ] }) });
  // 防抖与薄弱点（事件循环）无关——但按原标准判断为"高"（不因薄弱点而降级）
  setLlmResponses(JSON.stringify([
    { i: 0, value: "高", topic: "事件循环", leads: [] },
    { i: 1, value: "高", topic: "手写防抖", leads: [] },
  ]));
  try {
    await surfNowcoder({ userId: "500303394", goal: "字节前端面经" });
    const plan = getPlan();
    assert.ok(plan.items.some((i) => i.topic === "手写防抖"), "非薄弱点内容正常归档（不误杀）");
  } finally { globalThis.fetch = origFetch; }
});
