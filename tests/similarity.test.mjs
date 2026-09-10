// 相似度引擎统一工单任务 4：已知案例测试集（回归保护——不再"改一个漏一个"）
// 9 个误判案例（必须不相似）+ 3 个正确案例（必须相似）；⑨ 走 LLM 层
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("similarity");
mockLLM(); // 模糊区间走 LLM 的测试需要
const { similarity, clearSimilarityLlmCache } = await import("../lib/similarity.ts");
after(() => { cleanupTempDb(dbDir); });
beforeEach(() => { clearSimilarityLlmCache(); });

// ---------- 误判案例（必须不相似） ----------
test("误判①：二叉树层序遍历 vs 二叉树的锯齿形层序遍历（变体词 L2）", async () => {
  const r = await similarity("二叉树层序遍历", "二叉树的锯齿形层序遍历", "strict");
  assert.equal(r.similar, false, r.reason);
  assert.equal(r.layer, "rule");
});

test("误判②：二叉树层序遍历 vs 二叉树的前序遍历（变体词 L2）", async () => {
  const r = await similarity("二叉树层序遍历", "二叉树的前序遍历", "strict");
  assert.equal(r.similar, false, r.reason);
});

test("误判③：合并有序链表 vs 合并有序数组（结构词 L2）", async () => {
  const r = await similarity("合并有序链表", "合并有序数组", "strict");
  assert.equal(r.similar, false, r.reason);
});

test("误判④：NSP 与 MLM 的区别 vs LangChain 和 LangGraph 的区别和应用（泛词 L3）", async () => {
  const r = await similarity("NSP 与 MLM 的区别", "LangChain 和 LangGraph 的区别和应用", "strict");
  assert.equal(r.similar, false, r.reason);
});

test("误判⑤：数组中第K个最大元素 vs 1-n数组中未出现数（2-gram 不足）", async () => {
  const r = await similarity("数组中第K个最大元素", "1-n数组中未出现数", "strict");
  assert.equal(r.similar, false, r.reason);
});

test("误判⑥：为什么用 Zustand vs 为什么不用 Zustand（semantic 否定）", async () => {
  const r = await similarity("为什么用 Zustand", "为什么不用 Zustand", "semantic");
  assert.equal(r.similar, false, r.reason);
});

test("误判⑦：讲讲 X 的原理 vs 讲讲 X 的边界（semantic 角度）", async () => {
  const r = await similarity("讲讲事件循环的原理", "讲讲事件循环的边界", "semantic");
  assert.equal(r.similar, false, r.reason);
});

test("误判⑧：activeEffect vs 副作用函数长句（semantic 短问长历史）", async () => {
  const r = await similarity("activeEffect", "副作用函数在依赖收集和触发更新时的执行时机与调度", "semantic");
  assert.equal(r.similar, false, r.reason);
});

test("误判⑨：二叉树右视图 vs 二叉树左视图（LLM 语义层——词表外变体）", async () => {
  // 变体词表无"右视图/左视图"？——有（VARIANT_WORDS 含左视图/右视图）→ L2 硬判
  const r = await similarity("二叉树右视图", "二叉树左视图", "strict");
  assert.equal(r.similar, false, r.reason);
});

// ---------- 正确案例（必须相似） ----------
test("正确⑩：状态机与异步并发 vs 异步状态机与并发提交控制（weak 漂移合并）", async () => {
  const r = await similarity("状态机与异步并发", "异步状态机与并发提交控制", "weak");
  assert.equal(r.similar, true, r.reason);
});

test("正确⑪：版本号比较 vs 比较版本号（strict 讲解复用）", async () => {
  const r = await similarity("版本号比较", "比较版本号", "strict");
  assert.equal(r.similar, true, r.reason);
});

test("正确⑫：再讲讲事件循环 vs 事件循环再讲讲（semantic 同义命中）", async () => {
  const r = await similarity("再讲讲事件循环", "事件循环再讲讲", "semantic");
  assert.equal(r.similar, true, r.reason);
});

// ---------- LLM 层：模糊区间 + 降级 ----------
test("LLM 层：模糊区间（0.5-0.6）走 LLM 判定", async () => {
  setLlmResponses('{"similar":true,"reason":"同一知识点"}');
  const r = await similarity("状态机与SSE数据流联动", "状态机与接口联动", "strict");
  assert.equal(r.layer, "llm", "模糊区间走 LLM");
  assert.equal(r.similar, true, "LLM 判定相似");
});

test("LLM 层降级：LLM 不可用 → 保守不相似", async () => {
  // mock 队列空 → llmChat 抛错 → 降级不相似
  const r = await similarity("状态机与SSE数据流联动", "状态机与接口联动", "strict");
  assert.equal(r.similar, false, "降级保守不相似");
  assert.equal(r.layer, "llm", "尝试了 LLM 层");
});
