// RSS 聚合测试：fetchRss（假 parser 注入）+ buildDigest（LLM 注入：成功/失败/垃圾/去重/上限）
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM, setLlmResponses } from "./helpers.mjs";

// 必须先于动态 import rss.mjs：隔离真实 mianshi.db + mock llm.mjs（ai.mjs 动态 import 时命中）
setupTempDb("rss");
mockLLM();

const {
  fetchRss, buildDigest, getDigest, getFeeds, setFeeds, getLastDigestAt, setLastDigestAt, localToday, DEFAULT_FEEDS,
} = await import("../lib/rss.mjs");

// 生成 n 条测试资讯（link 唯一，publishedAt 递增——i 越大越新）
function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({
    feed: `feed-${i}`,
    title: `资讯标题 ${i}`,
    link: `https://example.com/item/${i}`,
    summary: `摘要 ${i}`,
    publishedAt: Date.now() - (n - i) * 1000,
  }));
}

// 假 parser：按 url 返回 feed；failUrls 里的 url 抛错（模拟单源失败/超时）
function fakeParser(feedsMap, { failUrls = [] } = {}) {
  return {
    parseURL: async (url) => {
      if (failUrls.includes(url)) throw new Error("boom");
      return feedsMap[url] || { title: "unknown", items: [] };
    },
  };
}

describe("fetchRss", () => {
  test("解析 items：title/link/summary/feed/publishedAt 正确，空 title/空 link 被过滤", async () => {
    const parser = fakeParser({
      "https://f1": {
        title: "源A",
        items: [{ title: "T1", link: "https://x/1", contentSnippet: "摘要1", isoDate: "2024-01-01T00:00:00Z" }],
      },
      "https://f2": {
        title: "源B",
        items: [
          { title: "", link: "https://x/2" },              // 缺标题 → 过滤
          { title: "T3", link: "", pubDate: "2024-01-02" }, // 缺链接 → 过滤
        ],
      },
    });
    const items = await fetchRss(["https://f1", "https://f2"], { parser });
    assert.equal(items.length, 1);
    assert.equal(items[0].feed, "源A");
    assert.equal(items[0].title, "T1");
    assert.equal(items[0].link, "https://x/1");
    assert.equal(items[0].summary, "摘要1");
    assert.ok(items[0].publishedAt > 0, "有时间戳");
  });

  test("单源失败 → 该源返回 []，不拖垮其它源", async () => {
    const parser = fakeParser(
      { "https://ok": { title: "OK", items: [{ title: "T", link: "https://x" }] } },
      { failUrls: ["https://bad"] }
    );
    const items = await fetchRss(["https://bad", "https://ok"], { parser });
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "T");
  });

  test("全部源失败 → 返回空数组", async () => {
    const parser = fakeParser({}, { failUrls: ["https://bad"] });
    const items = await fetchRss(["https://bad"], { parser });
    assert.deepEqual(items, []);
  });
});

describe("buildDigest", () => {
  test("LLM 成功 → 挑 5 条 + reason 入库（getDigest 可读回）", async () => {
    const items = makeItems(10);
    const llm = async () => JSON.stringify([
      { title: items[0].title, link: items[0].link, reason: "前端必看" },
      { title: items[1].title, link: items[1].link, reason: "求职关键" },
      { title: items[2].title, link: items[2].link, reason: "工程化重点" },
      { title: items[3].title, link: items[3].link, reason: "新工具" },
      { title: items[4].title, link: items[4].link, reason: "值得一读" },
    ]);
    const digest = await buildDigest(items, { llm });
    assert.equal(digest.length, 5);
    assert.equal(digest[0].reason, "前端必看");
    const stored = getDigest();
    assert.equal(stored.length, 5);
    assert.ok(stored.some((d) => d.reason === "前端必看"), "reason 已入库");
  });

  test("LLM 抛错 → fallback 取时间最新前 5 条，reason = —", async () => {
    const items = makeItems(8);
    const llm = async () => { throw new Error("network down"); };
    const digest = await buildDigest(items, { llm });
    assert.equal(digest.length, 5);
    assert.ok(digest.every((d) => d.reason === "—"));
    const sorted = [...items].sort((a, b) => b.publishedAt - a.publishedAt);
    assert.equal(digest[0].link, sorted[0].link);
  });

  test("LLM 返回垃圾（非 JSON）→ fallback", async () => {
    const items = makeItems(6);
    const llm = async () => "这不是 JSON";
    const digest = await buildDigest(items, { llm });
    assert.equal(digest.length, 5);
    assert.ok(digest.every((d) => d.reason === "—"));
  });

  test("默认 llm 走 ai.mjs chat（mockLLM 成功路径）", async () => {
    // 注：mock 返回的 link 必须是候选集内存在的（问题4修复：LLM picks 需与候选集交叉校验，
    // 候选里不存在的链接会被过滤，不再以 {feed:"",...} 构造入库）→ 改用 makeItems 里的真实 link
    setLlmResponses(JSON.stringify([{ title: "标题X", link: "https://example.com/item/0", reason: "理由X" }]));
    const digest = await buildDigest(makeItems(3)); // 不注入 llm → chat() → 被 mock 的 llm.mjs
    assert.equal(digest.length, 1);
    assert.equal(digest[0].reason, "理由X");
  });

  test("去重 + 空 items", async () => {
    const dup = [...makeItems(3), ...makeItems(3)]; // 相同 link 重复 → 去重后 3 条
    const llm = async () => { throw new Error("x"); };
    const digest = await buildDigest(dup, { llm });
    assert.equal(digest.length, 3);
    const empty = await buildDigest([], { llm });
    assert.deepEqual(empty, []);
  });
});

describe("配置 / 时间", () => {
  test("getFeeds 默认 / setFeeds 持久化 / 非法 URL 过滤", () => {
    assert.deepEqual(getFeeds(), DEFAULT_FEEDS);
    const r = setFeeds(["https://a.com", "not-a-url", "  https://b.com/feed  "]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.feeds, ["https://a.com", "https://b.com/feed"]);
    assert.deepEqual(getFeeds(), ["https://a.com", "https://b.com/feed"]);
    const bad = setFeeds(["not-a-url"]);
    assert.equal(bad.ok, false);
  });

  test("lastDigestAt 持久化", () => {
    setLastDigestAt(12345);
    assert.equal(getLastDigestAt(), 12345);
  });

  test("localToday 返回本地 YYYY-MM-DD", () => {
    assert.equal(localToday(new Date(2024, 0, 5)), "2024-01-05");
    assert.match(localToday(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
