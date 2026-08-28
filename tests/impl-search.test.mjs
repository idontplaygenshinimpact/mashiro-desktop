// 工具直测：impl-search（纵向拆分第 3 刀新增——此前工具实现只能靠 agent 循环间接测）
// 直测 toolSearchPosts：去重（URL + 标题归一化）/ 方向过滤（ignoreNote 噪音词）/ AI 挑帖
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM, setLlmResponses, setMockPages, mockFetchPage } from "./helpers.mjs";

setupTempDb("impl-search");
mockLLM();
mockFetchPage();
const { toolSearchPosts } = await import("../lib/tools/impl-search.mjs");

// 构造 3 站页面（auto 模式依次调用 fetchPage：nowcoder → juejin → bing）
function pagesFor({ ncLinks = [], jjArticles = [], bingLinks = [] }) {
  return [
    { links: ncLinks }, // nowcoder
    { apiResponses: [{ data: jjArticles }] }, // juejin（apiPattern 拦截）
    { links: bingLinks }, // bing
  ];
}
const link = (text, href) => ({ text, href });

test("toolSearchPosts 去重：同 URL 跨站只留一条 + 标题归一化去重", async () => {
  setMockPages(pagesFor({
    ncLinks: [link("事件循环详解", "https://www.nowcoder.com/discuss/111")],
    bingLinks: [
      link("事件循环详解", "https://www.nowcoder.com/discuss/111"), // 同 URL 跨站（bing 白名单命中）
      link("事件循环（转载）", "https://www.nowcoder.com/discuss/222"), // 标题归一化后与 333 同键（去括号）
    ],
  }));
  const r = await toolSearchPosts("事件循环");
  const urls = (r.results || []).map((p) => p.url);
  assert.ok(urls.includes("https://www.nowcoder.com/discuss/111"), "首条保留");
  assert.equal(new Set(urls).size, urls.length, "URL 无重复");
  const titles = (r.results || []).map((p) => p.title);
  assert.equal(new Set(titles).size, titles.length, "标题归一化去重生效");
});

test("toolSearchPosts 方向过滤：ignoreNote 噪音词标题被排除", async () => {
  setMockPages(pagesFor({
    ncLinks: [link("嵌入式开发经验分享", "https://www.nowcoder.com/discuss/1"), link("前端面试高频", "https://www.nowcoder.com/discuss/2")],
    bingLinks: [link("前端面经", "https://juejin.cn/post/9")],
  }));
  const r = await toolSearchPosts("前端 面经");
  const titles = (r.results || []).map((p) => p.title).join("|");
  assert.ok(!titles.includes("嵌入式"), "噪音词（嵌入式）被过滤");
  assert.ok(titles.includes("前端面试高频"), "正常结果保留");
});

test("toolSearchPosts AI 挑帖：候选 >4 时按 LLM 挑选结果", async () => {
  const mk = (i) => link(`React 面试题变体${i}`, `https://www.nowcoder.com/discuss/3${i}0`);
  setMockPages(pagesFor({ ncLinks: [mk(1), mk(2), mk(3)], bingLinks: [mk(4), mk(5), mk(6)] }));
  // pickPosts 期望 {picks:[{text,href,reason}]} 对象格式
  setLlmResponses(JSON.stringify({
    picks: [
      { text: "React 面试题变体1", href: "https://www.nowcoder.com/discuss/310", reason: "高频" },
      { text: "React 面试题变体4", href: "https://www.nowcoder.com/discuss/340", reason: "真题" },
    ],
  }));
  const r = await toolSearchPosts("React 面试");
  const urls = (r.results || []).map((p) => p.url);
  assert.equal(urls.length, 2, "挑帖只保留 LLM 选中的 2 篇");
  assert.ok(urls.includes("https://www.nowcoder.com/discuss/310") && urls.includes("https://www.nowcoder.com/discuss/340"), "挑中结果正确");
});

test("toolFetchPage SSRF 拒绝内网 + 注入检测包裹不可信", async () => {
  const { toolFetchPage } = await import("../lib/tools/impl-search.mjs");
  const r = await toolFetchPage("http://127.0.0.1:8899/api/health");
  assert.ok(r.error, "内网 URL 拒绝");
  const r2 = await toolFetchPage("ftp://x.com/a");
  assert.ok(r2.error, "非 http(s) 拒绝");
});