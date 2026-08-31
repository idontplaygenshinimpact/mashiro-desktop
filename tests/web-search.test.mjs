// web-search.mjs 单测：Bing 搜索结果解析 / 去重 / 失败降级（注入 fetchFn seam——2026-08 默认 fetchFn 改为 Node fetch，测试显式传 mock）
import { test } from "node:test";
import assert from "node:assert/strict";

const { searchWeb } = await import("../lib/web-search.mjs");

test("searchWeb 解析 Bing 搜索结果：title+url+snippet + URL 去重 + 导航过滤", async () => {
  const mockPage = {
    links: [
      { text: "React 19 新特性发布", href: "https://react.dev/blog/2025/12/05/react-19" },
      { text: "React 19 新特性详解", href: "https://juejin.cn/post/123" },
      { text: "下一页", href: "https://cn.bing.com/search?q=x&first=10" }, // 导航链接 → 过滤
      { text: "React 19 新特性发布", href: "https://react.dev/blog/2025/12/05/react-19" }, // 重复 URL → 去重
    ],
    text: "React 19 新特性发布\nActions 与 Server Components 稳定\nreact.dev\nReact 19 新特性详解\nuseOptimistic 等 hooks\njuejin.cn",
  };
  const r = await searchWeb("React 19 新特性", { fetchFn: async () => mockPage });
  assert.equal(r.length, 2, "去重后 2 条");
  assert.equal(r[0].title, "React 19 新特性发布");
  assert.equal(r[0].url, "https://react.dev/blog/2025/12/05/react-19");
  assert.equal(r[0].snippet, "Actions 与 Server Components 稳定", "从正文提取摘要");
  assert.equal(r[1].title, "React 19 新特性详解");
  assert.equal(r[1].snippet, "useOptimistic 等 hooks");
  assert.ok(!r.some((x) => x.url.includes("cn.bing.com")), "站内导航链接被过滤");
  assert.ok(r.every((x) => x.title && x.url), "每条都有 title+url");
});

test("searchWeb limit 截断到指定条数", async () => {
  const links = [];
  for (let i = 0; i < 6; i++) links.push({ text: `结果${i} 标题内容`, href: `https://example.com/${i}` });
  const r = await searchWeb("x", { limit: 3, fetchFn: async () => ({ links, text: "" }) });
  assert.equal(r.length, 3, "截断到 limit");
  assert.ok(r.every((x) => x.snippet === ""), "无正文时摘要为空串");
});

test("searchWeb 网络失败 → 返回 [] 不抛错（注入 fetchFn）", async () => {
  const r = await searchWeb("x", { fetchFn: async () => { throw new Error("network down"); } });
  assert.deepEqual(r, []);
});

test("searchWeb 空 query → 返回 []", async () => {
  assert.deepEqual(await searchWeb("   "), []);
  assert.deepEqual(await searchWeb(""), []);
});

test("searchWeb 无效页 / 空 links → 返回 []", async () => {
  assert.deepEqual(await searchWeb("x", { fetchFn: async () => ({ invalid: true, links: [] }) }), []);
  assert.deepEqual(await searchWeb("x", { fetchFn: async () => ({ links: [] }) }), []);
});
