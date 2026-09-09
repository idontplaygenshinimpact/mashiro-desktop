// project-doc skill 测试：分步生成 / 源码外信息注入 / 打磨循环 / 覆盖校验 / 缩水保护
// mockLLM 必须在 import 前（llm.mjs 未加载时 mock 才生效）
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("proj-doc");
mockLLM();
// mock buildProjectArchive（内部会跑 subagent 分组分析——消耗 mock 队列导致分步生成错位）；
// getPersonalProjects/savePersonalProjects 用真实（写 DB）
const realPP = await import("../lib/personal-projects.mjs");
const MOCK_SRC = [
  "--- src/store.js ---",
  "// 面试状态机：plan/round/review 三阶段",
  "export class InterviewStore {",
  "  constructor() { this.phase = 'plan'; this.rounds = []; }",
  "  advance() { this.phase = this.phase === 'plan' ? 'round' : 'review'; }",
  "  addRound(q, a) { this.rounds.push({ q, a }); }",
  "}",
  "--- src/sse.js ---",
  "// SSE 流式解析：data: 前缀 + [DONE] 终止",
  "export async function parseSSE(stream, onDelta) {",
  "  const reader = stream.getReader();",
  "  const dec = new TextDecoder();",
  "  while (true) { const { done, value } = await reader.read(); if (done) break; onDelta(dec.decode(value)); }",
  "}",
  "--- src/ai.js ---",
  "// AI 请求封装：AbortController 超时 + 重试退避",
  "export async function requestAI(prompt, { timeoutMs = 30000, retries = 1 } = {}) {",
  "  const ctrl = new AbortController();",
  "  const timer = setTimeout(() => ctrl.abort(), timeoutMs);",
  "  try { return await fetch('/api/ai', { signal: ctrl.signal, body: JSON.stringify({ prompt }) }); }",
  "  finally { clearTimeout(timer); }",
  "}",
].join("\n");
mock.module(new URL("../lib/personal-projects.mjs", import.meta.url).href, {
  namedExports: {
    getPersonalProjects: realPP.getPersonalProjects,
    savePersonalProjects: realPP.savePersonalProjects,
    buildProjectArchive: async () => ({ content: MOCK_SRC }),
  },
});
const { generateProjectDoc } = await import("../skills/project-doc/skill.mjs");

let projDir = null;
before(() => {
  projDir = mkdtempSync(path.join(tmpdir(), "pd-"));
  mkdirSync(path.join(projDir, "src"), { recursive: true });
  mkdirSync(path.join(projDir, "docs"), { recursive: true });
  writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "demo-app", dependencies: { react: "^18", zustand: "^4" } }));
  writeFileSync(path.join(projDir, "README.md"), "# demo-app\n\nAI 面试训练平台：模拟面试 + 手写练习。性能：首屏 JS 313kB→147kB（-53%）。用户：开源作品集。\n");
  writeFileSync(path.join(projDir, "docs", "performance-report.md"), "# 性能报告\nLCP 2.9s→0.6s，Lighthouse 65→89。\n");
  writeFileSync(path.join(projDir, "src", "store.js"), [
    "// 面试状态机：plan/round/review 三阶段",
    "export class InterviewStore {",
    "  constructor() { this.phase = 'plan'; this.rounds = []; }",
    "  advance() { this.phase = this.phase === 'plan' ? 'round' : 'review'; }",
    "  addRound(q, a) { this.rounds.push({ q, a }); }",
    "}",
  ].join("\n"));
  writeFileSync(path.join(projDir, "src", "sse.js"), [
    "// SSE 流式解析：data: 前缀 + [DONE] 终止",
    "export async function parseSSE(stream, onDelta) {",
    "  const reader = stream.getReader();",
    "  const dec = new TextDecoder();",
    "  while (true) { const { done, value } = await reader.read(); if (done) break; onDelta(dec.decode(value)); }",
    "}",
  ].join("\n"));
  realPP.savePersonalProjects([{ name: "demo-app", dir: projDir }]);
});
after(() => { cleanupTempDb(dbDir); });

test("generate_project_doc：分步生成 + 源码外信息注入 + 覆盖校验", async () => {
  // 响应队列：概览/源码要点/八股/问答×5/讲述/评审(PASS)
  setLlmResponses(
    "## 项目概览\n一句话定位：AI 面试训练平台。\n技术栈：React/Zustand。\n架构：store + sse。\n核心模块：模拟面试/手写练习。\n关键设计决策：三阶段状态机、SSE 流式。\n性能：首屏 313kB→147kB（-53%）。",
    "## 源码要点\nstore.js：InterviewStore 状态机（plan/round/review 三阶段，advance 流转）。坑：phase 无非法状态校验。\nsse.js：parseSSE 流式解析（TextDecoder 分块解码）。坑：跨 chunk 半行未缓冲。",
    "【八股】状态机：InterviewStore 三阶段流转。追问：状态机 vs 布尔标志？\n【八股】SSE 流式：parseSSE 解析 data: 前缀。追问：SSE vs WebSocket？跨 chunk 处理？",
    "## 模块拷打\nQ1: 状态机怎么设计的？\nA1: plan/round/review 三阶段，advance 流转。\nQ2: 为什么用状态机？\nA2: 保证任何操作不进入非法状态。",
    "## 链路拷打\nQ1: SSE 流式怎么处理跨 chunk？\nA1: TextDecoder 分块解码，需缓冲残留。",
    "## 压力问题\nQ1: 最复杂的是什么？\nA1: 面试状态机 + 流式输出。\nQ2: 重做会改什么？\nA2: SSE 行缓冲。",
    "## 场景题与产品向\nQ1: 白屏怎么排查？\nA1: 网络→控制台→渲染→后端。\nQ2: 用户有多少？\nA2: 开源作品集，无商业用户。\nQ3: AI 参与度？\nA3: 架构决策自己做的。",
    "## 手写题与反问叙事\nQ1: 手写防抖节流？\nA1: 定时器实现。\nQ2: 反问什么？\nA2: 团队技术栈。\nQ3: 为什么做？\nA3: 秋招训练闭环。",
    "## 讲述方法论\n三层讲述法：背景→技术→价值。五段式模板。追问应对：埋点引导。",
    "PASS：全部章节覆盖，质量达标。"
  );
  const r = await generateProjectDoc({ project: "demo-app", force: true });
  assert.equal(r.ok, true, "生成成功");
  assert.ok(r.docPath, "有存档路径");
  const doc = readFileSync(r.docPath, "utf8");
  // 覆盖校验：17 章缺 ≤1
  assert.ok(doc.includes("项目概览"), "含项目概览");
  assert.ok(doc.includes("源码要点"), "含源码要点");
  assert.ok(doc.includes("八股"), "含八股");
  assert.ok(doc.includes("模块拷打"), "含模块拷打");
  assert.ok(doc.includes("链路拷打"), "含链路拷打");
  assert.ok(doc.includes("压力问题"), "含压力问题");
  assert.ok(doc.includes("场景题"), "含场景题");
  assert.ok(doc.includes("产品向"), "含产品向");
  assert.ok(doc.includes("AI 参与度"), "含 AI 参与度");
  assert.ok(doc.includes("手写题"), "含手写题");
  assert.ok(doc.includes("反问"), "含反问");
  assert.ok(doc.includes("为什么做"), "含项目叙事");
  assert.ok(doc.includes("讲述方法论"), "含讲述方法论");
  // 源码外信息注入（README 性能数据进文档）
  assert.ok(doc.includes("313kB"), "README 性能数据已注入");
  assert.ok(r.coverage.includes("18/18") || r.coverage.includes("17/18"), `覆盖校验 ≥95%（实际 ${r.coverage}）`);
});

test("generate_project_doc：缓存命中（已存在且非失败态）", async () => {
  setLlmResponses(); // 清空队列——若重新生成会因队列空失败
  const r = await generateProjectDoc({ project: "demo-app" });
  assert.equal(r.ok, true);
  assert.ok(String(r.coverage || "").includes("缓存"), "读缓存不重新生成");
});
