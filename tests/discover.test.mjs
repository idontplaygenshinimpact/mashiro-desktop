// discover 管线阶段测试：collectPostsStage（列表提取/去重/历史过滤/AI挑帖）+ classifyStage（方向过滤/分流）
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mockFetchPage, setMockPages } from "./helpers.mjs";

// mock ai.mjs（discover 静态 import classifyPage/pickPosts/detectQuestions 等）
const calls = { pick: [], classify: [], detect: [] };
mock.module(new URL("../lib/ai.mjs", import.meta.url).href, {
  namedExports: {
    classifyPage: async ({ title, text }) => {
      const r = { type: "other", direction: "other", company: "", position: "", worth: 50, reason: "mock" };
      if (title.includes("面经")) { r.type = "mianshi"; r.direction = "frontend"; }
      if (title.includes("招聘")) { r.type = "zhaopin"; r.direction = "frontend"; }
      if (title.includes("后端")) { r.direction = "backend"; }
      calls.classify.push(title);
      return r;
    },
    detectQuestions: async () => ({ hasQuestion: true, questions: [{ question: "题目1" }], reason: "mock" }),
    pickPosts: async (posts, want, focus) => { calls.pick.push({ n: posts.length, want }); return posts.slice(0, want).map((p) => ({ ...p, reason: "mock" })); },
    solveQuestion: async () => "# 讲解",
    summarizeQiuzhao: async () => "# 情报",
  },
});
mockFetchPage();
const discover = await import("../discover.mjs");

beforeEach(() => {
  calls.pick.length = 0;
  calls.classify.length = 0;
  setMockPages([]);
});

test("collectPostsStage：提取帖子链接 + 去重 + 历史过滤 + AI 挑帖", async () => {
  setMockPages([
    {
      text: "mock正文".repeat(30),
      links: [
        { text: "字节前端一面面经", href: "https://www.nowcoder.com/discuss/111" },
        { text: "字节前端一面面经（重复）", href: "https://www.nowcoder.com/discuss/111?searchId=1" }, // 同帖去重
        { text: "嵌入式开发求职", href: "https://www.nowcoder.com/discuss/222" }, // 标题过滤
        { text: "React 面试题整理", href: "https://juejin.cn/post/333" },
      ],
    },
  ]);
  const ctx = { startUrls: ["https://www.nowcoder.com/discuss?type=2&query=前端"], want: 3, history: new Set(["discuss:222"]) };
  await discover.collectPostsStage(ctx);
  assert.equal(calls.pick.length, 1, "调 AI 挑帖");
  assert.equal(calls.pick[0].n, 2, "过滤后候选：去重 1 + 标题过滤 1 + 历史过滤 1");
  const hrefs = ctx.allPicked.map((p) => p.href);
  assert.ok(hrefs.includes("https://www.nowcoder.com/discuss/111"), "保留牛客帖");
  assert.ok(hrefs.includes("https://juejin.cn/post/333"), "保留掘金帖");
  assert.ok(!hrefs.some((h) => h.includes("222")), "历史已爬被过滤");
  assert.ok(!hrefs.some((h) => h.includes("?searchId")), "链接清洗去跟踪参数");
});

test("classifyStage：前端方向保留 + 后端丢弃 + zhaopin 分流情报", async () => {
  const ctx = {
    okPages: [
      { title: "字节前端一面面经", text: "正文", url: "u1" },
      { title: "某公司招聘信息", text: "正文", url: "u2" },
      { title: "Java 后端面经", text: "正文", url: "u3" },
    ],
  };
  await discover.classifyStage(ctx);
  assert.equal(ctx.items.length, 1, "只保留前端面经");
  assert.equal(ctx.items[0].title, "字节前端一面面经");
  assert.equal(ctx.qiuItems.length, 1, "招聘类分流到情报");
  assert.equal(ctx.qiuItems[0].title, "某公司招聘信息");
  assert.ok(!ctx.items.some((i) => i.title.includes("后端")), "后端方向丢弃");
});

test("initStage 读取 CLI 参数（默认值兜底）", async () => {
  const ctx = {};
  await discover.initStage(ctx);
  assert.ok(Array.isArray(ctx.startUrls) && ctx.startUrls.length > 0, "起始 URL 列表");
  assert.ok(ctx.want >= 1, "挑帖数量");
  assert.ok(ctx.history instanceof Set, "历史去重集合");
});
