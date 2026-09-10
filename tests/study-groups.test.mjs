// study-groups.mjs 测试：大类归一化（仅临时 DB 供 knowledge 知识树，独立直测）
// 纵向拆分第 4 刀：纯函数域拆出后的零 mock 直测
// 分类判定相似度引擎工单任务 1：normalizeGroupAsync 的 LLM 语义层测试需要 mockLLM
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";
import { normalizeGroup, kwHit } from "../lib/study-groups.mjs";

const dbDir = setupTempDb("study-groups");
mockLLM();

test("normalizeGroup：手写/算法强信号优先于知识树泛词（手撕LRU 不再进浏览器）", () => {
  assert.equal(normalizeGroup("手撕LRU缓存"), "算法与手写", "手撕 → 算法");
  assert.equal(normalizeGroup("LRU缓存"), "算法与手写", "lru → 算法");
  assert.equal(normalizeGroup("手写防抖节流"), "算法与手写", "手写 → 算法");
  assert.equal(normalizeGroup("大厂手写 Promise.all"), "算法与手写", "大厂手写 → 算法");
});

test("normalizeGroup：知识树正常命中不被破坏（HTTP 缓存仍归浏览器原理）", () => {
  // 不含手写/手撕/lru 强信号 → 走知识树，仍是浏览器原理（防过度归类）
  assert.equal(normalizeGroup("HTTP强缓存与协商缓存"), "浏览器原理");
  assert.equal(normalizeGroup("HTTP缓存"), "浏览器原理");
});

test("normalizeGroup：兜底规则 / 其他", () => {
  assert.equal(normalizeGroup("MySQL 索引回表"), "数据库", "数据库兜底");
  assert.equal(normalizeGroup("RAG 向量检索"), "Agent与LLM", "RAG 兜底");
  assert.equal(normalizeGroup("面试自我介绍模板"), "面试与求职", "面试兜底");
  assert.equal(normalizeGroup("完全不认识的主题词xyz"), "其他", "都不中 → 其他");
});

test("方案②：独立成词检测——组合词不触发强语义词（技术栈/消息队列/知识树）", () => {
  // 子串匹配无法区分词义：'技术栈'含'栈'、'消息队列'含'队列'、'知识树'含'树'
  assert.equal(kwHit("react 技术栈", "栈"), false, "技术栈不触发栈");
  assert.equal(kwHit("用栈实现括号匹配", "栈"), true, "独立栈触发");
  assert.equal(kwHit("消息队列实现", "队列"), false, "消息队列不触发队列");
  assert.equal(kwHit("宏任务与微任务队列", "队列"), false, "事件循环队列不触发");
  assert.equal(kwHit("知识树分类", "树"), false, "知识树不触发树");
  assert.equal(kwHit("UML流程图", "图"), false, "流程图不触发图");
  assert.equal(kwHit("二叉树遍历", "树"), true, "二叉树触发（算法语义保留）");
  // normalizeGroup 组合场景
  assert.equal(normalizeGroup("用栈实现括号匹配"), "算法与手写", "独立栈仍归算法");
  assert.equal(normalizeGroup("二叉树层次遍历"), "算法与手写", "二叉树仍归算法");
  assert.equal(normalizeGroup("消息队列与事件循环"), "JavaScript 核心", "事件循环队列不被算法吸走");
});

test("方案③：LLM/Agent 领域强信号优先于知识树（LLM 基础不再进 CSS/HTML）", () => {
  assert.equal(normalizeGroup("LLM 基础与 Transformer 原理"), "Agent与LLM", "LLM 题归 Agent与LLM");
  assert.equal(normalizeGroup("AI Agent LLM 微调与量化部署"), "Agent与LLM", "微调量化归 Agent与LLM");
});

test("方案③：项目条目按技术栈/原分组归类（项目名含领域词不被吸走）", () => {
  assert.equal(normalizeGroup("项目·AgentChat 智能对话平台", "React", "React 技术栈"), "React", "项目条目保留原分组");
  assert.equal(normalizeGroup("项目·mashiro-desktop 桌宠", "React", "React 技术栈"), "React", "桌宠项目归 React");
});

// ---------- 分类判定相似度引擎工单任务 1：similarity 规则层兜底（词表外新题归位） ----------
test("任务1：词表外算法题经 similarity 规则层归位（爬楼梯/两数相加/二分查找/LCR/螺旋矩阵）", () => {
  // 这些题词表未覆盖（此前错分"其他"）——similarity 对代表词 weak 判定归"算法与手写"
  assert.equal(normalizeGroup("爬楼梯"), "算法与手写", "爬楼梯归算法");
  assert.equal(normalizeGroup("两数相加"), "算法与手写", "两数相加归算法");
  assert.equal(normalizeGroup("二分查找"), "算法与手写", "二分查找归算法");
  assert.equal(normalizeGroup("LCR 螺旋矩阵"), "算法与手写", "螺旋矩阵归算法");
  assert.equal(normalizeGroup("最长无重复子串"), "算法与手写", "最长无重复子串归算法");
  assert.equal(normalizeGroup("买卖股票的最佳时机"), "算法与手写", "股票归算法");
  assert.equal(normalizeGroup("三数之和"), "算法与手写", "三数之和归算法");
});

test("任务1：similarity 规则层不误伤（无关主题仍归其他）", () => {
  assert.equal(normalizeGroup("完全不认识的主题词xyz"), "其他", "无关仍其他");
  assert.equal(normalizeGroup("今天天气不错"), "其他", "日常话题仍其他");
});

test("任务1：similarityGroupRule 缓存幂等（同 topic 不重复判定）", async () => {
  const { similarityGroupRule } = await import("../lib/study-groups.mjs");
  assert.equal(similarityGroupRule("爬楼梯"), "算法与手写");
  assert.equal(similarityGroupRule("爬楼梯"), "算法与手写", "缓存命中同结果");
  assert.equal(similarityGroupRule(""), null, "空 topic 返回 null");
});

test("任务1：normalizeGroupAsync 规则层未命中 → LLM 语义层归组", async () => {
  const { normalizeGroupAsync } = await import("../lib/study-groups.mjs");
  // 规则层未命中的模糊题 → LLM 判定归"算法与手写"
  setLlmResponses('{"group":"算法与手写"}');
  const g = await normalizeGroupAsync("某道模糊算法变体题", "", "");
  assert.equal(g, "算法与手写", "LLM 语义层归组");
});

after(() => { cleanupTempDb(dbDir); });
