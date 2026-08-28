// study-topic.mjs 测试：topic 归一化 + 相似判定（零依赖零 mock——纯函数独立直测）
// 纵向拆分第 4 刀：纯函数域拆出后的零 mock 直测
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTopic, isSimilarTopic } from "../lib/study-topic.mjs";

test("normalizeTopic：去括号内容/标点/连词/修饰后缀", () => {
  assert.equal(normalizeTopic("事件循环（含宏任务与微任务）"), "事件循环", "括号及内容整体删除");
  assert.equal(normalizeTopic("HTTP 缓存机制详解"), "http缓存", "空格与修饰后缀去除");
  assert.equal(normalizeTopic("防抖与节流的区别"), "防抖节流区别", "连词去除");
  assert.ok(normalizeTopic("React Hooks 原理").startsWith("reacthooks"), "英文小写保留");
});

test("normalizeTopic：长度截断 ≤20", () => {
  const t = normalizeTopic("这是一个非常非常长的知识点标题用来测试截断行为是否正确");
  assert.ok(t.length <= 20, "截断到 20 字符");
});

test("isSimilarTopic：相等/包含判定", () => {
  assert.equal(isSimilarTopic("事件循环", "事件循环"), true, "相等");
  assert.equal(isSimilarTopic("事件循环", "事件循环微任务"), true, "中文包含（词边界）");
  assert.equal(isSimilarTopic("HTTP", "HTTP缓存"), true, "短串在前");
  assert.equal(isSimilarTopic("HTTP缓存", "HTTP"), true, "长串在前");
});

test("isSimilarTopic：词边界防误判（React/ReactNative、CSS/CSS3、HTTP/HTTPS）", () => {
  assert.equal(isSimilarTopic("react", "reactnative"), false, "React ⊄ ReactNative（词中拼接）");
  assert.equal(isSimilarTopic("css", "css3"), false, "CSS ⊄ CSS3（数字边界）");
  assert.equal(isSimilarTopic("http", "https"), false, "HTTP ⊄ HTTPS");
  assert.equal(isSimilarTopic("事件循环", "事件循环微任务"), true, "中文词边界仍相似");
});

test("isSimilarTopic：空值/无包含", () => {
  assert.equal(isSimilarTopic("", "x"), false, "空串");
  assert.equal(isSimilarTopic(null, "x"), false, "null");
  assert.equal(isSimilarTopic("abc", "xyz"), false, "无包含");
});
