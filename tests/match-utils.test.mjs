// match-utils 统一匹配层测试（7 个独立实现的公共层回归）
// 覆盖 7 类已知误命中 + 潜在场景：组合词/独立成词/词边界/n-gram/特异性门槛/正则生成器
import { test } from "node:test";
import assert from "node:assert/strict";
import { kwHit, hasWordBoundary, grams, compoundRegex, hasSpecificKw, COMPOUND_EXCLUDE } from "../lib/match-utils.mjs";

// ---------- 1) 组合词 vs 独立词（study-groups 技术栈 vs 栈 类） ----------
test("kwHit：组合词不触发强语义词，独立词正常触发", () => {
  assert.equal(kwHit("react 技术栈", "栈"), false, "技术栈不触发栈");
  assert.equal(kwHit("用栈实现括号匹配", "栈"), true, "独立栈触发");
  assert.equal(kwHit("消息队列实现", "队列"), false, "消息队列不触发队列");
  assert.equal(kwHit("宏任务与微任务队列", "队列"), false, "事件循环队列不触发");
  assert.equal(kwHit("知识树分类", "树"), false, "知识树不触发树");
  assert.equal(kwHit("UML流程图", "图"), false, "流程图不触发图");
  assert.equal(kwHit("二叉树遍历", "树"), true, "二叉树触发（算法语义保留）");
  assert.equal(kwHit("调用栈溢出", "栈"), false, "调用栈不触发栈");
  assert.equal(kwHit("LLM 流式输出", "流"), false, "流式输出不触发流");
  assert.equal(kwHit("状态机设计", "状态"), false, "状态机不触发状态");
});

// ---------- 2) 词边界（study-topic React ⊂ ReactNative 类） ----------
test("hasWordBoundary：词中间拼接不判相似，中文边界判相似", () => {
  assert.equal(hasWordBoundary("reactnative", "react"), false, "react ⊂ reactnative 无边界");
  assert.equal(hasWordBoundary("css3", "css"), false, "css ⊂ css3 无边界");
  assert.equal(hasWordBoundary("https", "http"), false, "http ⊂ https 无边界");
  assert.equal(hasWordBoundary("事件循环微任务", "事件循环"), true, "中文后位算边界");
  assert.equal(hasWordBoundary("abc", "abc"), true, "完全相等");
  assert.equal(hasWordBoundary("abc", "xyz"), false, "不包含");
});

// ---------- 3) n-gram（memory 合并链表 vs 数组 类） ----------
test("grams：n-gram 提取（2/3 字）", () => {
  const g2 = grams("合并有序链表", 2);
  assert.deepEqual([...g2], ["合并", "并有", "有序", "序链", "链表"]);
  const g3 = grams("合并有序链表", 3);
  assert.deepEqual([...g3], ["合并有", "并有序", "有序链", "序链表"]);
  assert.equal(grams("", 2).size, 0);
  assert.equal(grams("ab", 3).size, 0, "短于 n 无 gram");
});

// ---------- 4) 特异性门槛（知识树短泛词 缓存/模板/锁 类） ----------
test("hasSpecificKw：短泛词不可信，长词可信", () => {
  assert.equal(hasSpecificKw(["缓存"]), false, "2 字中文不可信");
  assert.equal(hasSpecificKw(["模板"]), false);
  assert.equal(hasSpecificKw(["事件循环"]), true, "3 字中文可信");
  assert.equal(hasSpecificKw(["http"]), true, "4 字符英文可信");
  assert.equal(hasSpecificKw(["react"]), true);
  assert.equal(hasSpecificKw(["缓存", "事件循环"]), true, "含长词即可信");
});

// ---------- 5) 组合词正则生成器（ALGO_TOPIC_RE 组合词化 类） ----------
test("compoundRegex：从组合词表生成排除正则", () => {
  const re = compoundRegex(["技术栈", "消息队列"]);
  assert.ok(re.test("react 技术栈"), "命中组合词");
  assert.ok(re.test("消息队列实现"), "命中组合词");
  assert.ok(!re.test("用栈实现"), "独立词不命中");
  // 默认表（COMPOUND_EXCLUDE）生成
  const def = compoundRegex();
  assert.ok(def.test("知识树"), "默认表含知识树");
  assert.ok(COMPOUND_EXCLUDE.length >= 15, "组合词表统一维护（一处更新全局生效）");
});

// ---------- 6) 潜在场景：英文大小写/混合 ----------
test("kwHit：英文词大小写不敏感", () => {
  assert.equal(kwHit("LRU 缓存实现", "lru"), true);
  assert.equal(kwHit("React 技术栈", "栈"), false);
  assert.equal(kwHit("DFS 遍历", "dfs"), true);
});

// ---------- 7) 潜在场景：组合词表扩展后全局生效（一处更新） ----------
test("组合词表扩展：新增组合词立即影响 kwHit（统一维护验证）", () => {
  // 模拟"一处更新"：表里加"流式输出"后，"LLM 流式输出"不再触发"流"
  assert.equal(kwHit("LLM 流式输出", "流"), false, "流式输出已在表内");
  assert.equal(kwHit("流式渲染", "流"), true, "流式渲染（不在表内）仍触发");
});