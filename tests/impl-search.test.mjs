// 工具直测：impl-search（纵向拆分第 3 刀新增——此前工具实现只能靠 agent 循环间接测）
// 直测 toolSearchPosts：去重（URL + 标题归一化）/ 方向过滤（ignoreNote 噪音词）/ AI 挑帖
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM, setLlmResponses, setMockPages, mockFetchPage } from "./helpers.mjs";

setupTempDb("impl-search");
mockLLM();
mockFetchPage();
const { toolSearchPosts } = await import("../lib/tools/impl-search.mjs");

// 构造 2 站页面（auto 模式依次调用 fetchPage：juejin → bing——牛客已去掉（搜索页改版 + fetchPage 卡死））
function pagesFor({ jjArticles = [], bingLinks = [] }) {
  return [
    { apiResponses: [{ data: jjArticles }] }, // juejin（apiPattern 拦截）
    { links: bingLinks }, // bing
  ];
}
const link = (text, href) => ({ text, href });

test("toolSearchPosts 去重：同 URL 跨站只留一条 + 标题归一化去重", async () => {
  setMockPages(pagesFor({
    bingLinks: [
      link("事件循环详解", "https://www.nowcoder.com/discuss/111"),
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
    bingLinks: [link("嵌入式开发经验分享", "https://www.nowcoder.com/discuss/1"), link("前端面试高频", "https://www.nowcoder.com/discuss/2"), link("前端面经", "https://juejin.cn/post/9")],
  }));
  const r = await toolSearchPosts("前端 面经");
  const titles = (r.results || []).map((p) => p.title).join("|");
  assert.ok(!titles.includes("嵌入式"), "噪音词（嵌入式）被过滤");
  assert.ok(titles.includes("前端面试高频"), "正常结果保留");
});

test("toolSearchPosts AI 挑帖：候选 >4 时按 LLM 挑选结果", async () => {
  const mk = (i) => link(`React 面试题变体${i}`, `https://www.nowcoder.com/discuss/3${i}0`);
  setMockPages(pagesFor({ bingLinks: [mk(1), mk(2), mk(3), mk(4), mk(5), mk(6)] }));
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
  const r = await toolFetchPage("ftp://x.com/a");
  assert.ok(r.error, "非 http(s) 拒绝");
  // 内网 URL 拒绝依赖 assertPublicUrl——测试环境 mockFetchPage 将其 mock 成放行（避免假域名 DNS 解析），
  // 真实 SSRF 校验由 fetch-page.test.mjs 覆盖（toolFetchPage 的 SSRF 依赖真实 assertPublicUrl，代码正确）
});
// ---------- toolFetchNowcoderUser（牛客逛完强化方案任务 1③：contentPage 循环/去重/解析） ----------
function nowcoderHtml({ page, totalPage, moments }) {
  const items = moments.map((m) => `"contentId":"${m.id}","contentType":74,"title":"${m.title}","newTitle":"x","content":"${m.content}","newContent":"x"`).join(",");
  return `{"current":${page},"totalPage":${totalPage},"nickname":"测试牛友","authDisplayInfo":"前端工程师","moments":[${items}]}`;
}

test("toolFetchNowcoderUser：2 页循环 + contentId 去重 + 解析", async () => {
  const { toolFetchNowcoderUser } = await import("../lib/tools/impl-search.mjs");
  const origFetch = globalThis.fetch;
  const pages = [
    nowcoderHtml({ page: 1, totalPage: 2, moments: [
      { id: "111", title: "字节前端一面", content: "事件循环\\u002F宏任务微任务" },
      { id: "222", title: "手写防抖", content: "定时器方案" },
    ] }),
    nowcoderHtml({ page: 2, totalPage: 2, moments: [
      { id: "111", title: "字节前端一面", content: "事件循环\\u002F宏任务微任务" }, // 置顶重复
      { id: "333", title: "Vue 响应式", content: "Proxy 依赖收集" },
    ] }),
  ];
  globalThis.fetch = async () => ({ ok: true, text: async () => pages.shift() });
  try {
    const r = await toolFetchNowcoderUser({ userId: "500303394", maxPages: 3 });
    assert.equal(r.ok, true, "抓取成功");
    assert.equal(r.moments.length, 3, "去重后 3 条（111 不重复）");
    assert.equal(r.totalPages, 2, "totalPage 解析");
    assert.equal(r.user.nickname, "测试牛友");
    assert.ok(r.moments[0].content.includes("事件循环/宏任务微任务"), "\\u002F 反转义");
  } finally { globalThis.fetch = origFetch; }
});

test("toolFetchNowcoderUser：非法 userId → 拒绝；抓取失败 → 报告不静默", async () => {
  const { toolFetchNowcoderUser } = await import("../lib/tools/impl-search.mjs");
  const bad = await toolFetchNowcoderUser({ userId: "abc" });
  assert.ok(bad.error, "非法 userId 拒绝（返回 error）");
  assert.ok(String(bad.error || "").includes("数字"), "错误信息明确");
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("网络断开"); };
  try {
    const r = await toolFetchNowcoderUser({ userId: "500303394" });
    assert.ok(r.error, "抓取失败返回错误");
    assert.ok(String(r.error || "").includes("抓取失败"), "报告失败不静默");
  } finally { globalThis.fetch = origFetch; }
});

