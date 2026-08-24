// tests/panel-challenges.test.mjs —— 手写题库面板功能（搜索/状态筛选/懒加载/编辑器高亮）
// 背景：448 道题单列表太长难找 + 编辑器纯 txt 无高亮 → 新增搜索框/状态 chips/懒加载/
//       description 摘要/行号+语法高亮编辑器。本测试用 jsdom 全流程验证这些交互。
import { bootPanel, tick } from "./panel-helper.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const TOTAL = 85; // 懒加载阈值 60 之上，确保"加载更多"出现

function mk(i) {
  const handwrite = i % 5 < 2;
  return {
    id: handwrite ? `hw-${i}` : `alg-${i}`,
    title: handwrite ? `手写 Promise 系列 ${i}` : `算法题 ${i}: 二叉树遍历 ${i}`,
    category: handwrite ? "handwrite" : "algorithm",
    difficulty: (i % 3) + 1,
    frequency: (i % 5) + 1,
    timeLimit: 10,
    description: handwrite ? `手写实现第 ${i} 号函数，考察原型链与异步` : `给定数组/二叉树，实现第 ${i} 号算法`,
    skeleton: "function solve() {\n  // TODO\n}",
    done: i % 7 === 0, // 含 i=0 → 13 条已做，72 条未做
    wrongCount: i % 11 === 0 ? 2 : 0,
  };
}

function bootChallenges() {
  const list = Array.from({ length: TOTAL }, (_, i) => mk(i));
  const ctx = bootPanel({});
  ctx.window.fetch = async (url) => {
    const u = String(url);
    let j;
    if (u.includes("/api/challenges?")) j = { ok: true, total: TOTAL, done: 13, left: TOTAL - 13, list };
    else if (u.includes("/api/challenges/detail")) {
      const id = decodeURIComponent(u.split("id=")[1] || "");
      j = { ok: true, detail: list.find((p) => p.id === id) || { id, title: "x", category: "algorithm", difficulty: 1, timeLimit: 10, description: "d", skeleton: "function solve() {\n  // TODO\n}" } };
    } else j = { ok: true, items: [], list: [], plan: { items: [] } };
    return { ok: true, json: async () => j };
  };
  ctx.window.loadChallenges(); // bootPanel eval 时已用默认 mock 跑过一次（空 list），覆盖 fetch 后重拉
  return ctx;
}

async function withChallenges(fn) {
  const ctx = bootChallenges();
  try {
    await tick(50);
    return await fn(ctx);
  } finally {
    ctx.window.clearAllTimers();
    ctx.dom.window.close();
  }
}

const items = (ctx) => ctx.window.document.getElementById("challenge-list").querySelectorAll(".job-item");
const $ = (ctx, id) => ctx.window.document.getElementById(id);
const chips = (ctx) => [...ctx.window.document.querySelectorAll("#challenge-cats .oj-cat-chip")];
const click = (ctx, el) => { el.click(); return tick(30); };

test("懒加载：首屏 60 条 + 「加载更多」按钮 + 描述摘要", async () => {
  await withChallenges(async (ctx) => {
    assert.equal(items(ctx).length, 60, "首屏应只渲染 60 条");
    const more = $(ctx, "challenge-list").querySelector(".ch-more");
    assert.ok(more && more.textContent.includes("25"), "应显示剩余 25 条的加载按钮");
    assert.ok(items(ctx)[0].querySelector(".job-summary"), "条目应含描述摘要");
  });
});

test("搜索框：关键词过滤 + 命中计数", async () => {
  await withChallenges(async (ctx) => {
    const search = $(ctx, "challenge-search");
    search.value = "Promise";
    search.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
    await tick(30);
    const n = items(ctx).length;
    assert.ok(n > 0 && n < 60, `搜索「Promise」应过滤到 60 条以内，got ${n}`);
    assert.match($(ctx, "challenge-count").textContent, /命中/, "应显示命中计数");
  });
});

test("状态筛选：已做 13 / 未做 72（懒加载内 60）", async () => {
  await withChallenges(async (ctx) => {
    await click(ctx, chips(ctx).find((b) => b.dataset.done === "2"));
    assert.equal(items(ctx).length, 13, "已做 13 条（i%7==0 含 i=0）");
    await click(ctx, chips(ctx).find((b) => b.dataset.done === "1"));
    assert.equal(items(ctx).length, 60, "未做 72 条，懒加载先显 60");
    $(ctx, "challenge-list").querySelector(".ch-more").click();
    await tick(30);
    assert.equal(items(ctx).length, 72, "加载更多后 72 条全显");
  });
});

test("编辑器：行号 + 语法高亮 + 随输入更新", async () => {
  await withChallenges(async (ctx) => {
    items(ctx)[0].querySelector(".ch-practice").click();
    await tick(60);
    const editor = ctx.window.document.querySelector(".ch-editor");
    assert.ok(editor, "做题编辑器应展开");
    const hl = editor.querySelector(".ch-hl");
    const lines = editor.querySelector(".ch-lines");
    const ta = editor.querySelector(".ch-ta");
    assert.ok(lines, "行号列存在");
    assert.ok(hl, "高亮层存在");
    ta.value = "function a() { return 1; }";
    ta.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
    await tick(10);
    assert.ok(hl.innerHTML.includes('font-weight:600;">function</span>'), "function 关键字应着紫色 span");
    assert.ok(hl.innerHTML.includes('color:#2f7d4e;">a</span>'), "函数名 a 应着绿色 span");
    assert.equal(lines.textContent.trim(), "1", "行号应为 1");
  });
});
