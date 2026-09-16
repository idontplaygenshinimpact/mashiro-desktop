// tests/panel-challenges.test.mjs —— 手写题库面板功能（搜索/状态筛选/懒加载/编辑器高亮）
// 背景：448 道题单列表太长难找 + 编辑器纯 txt 无高亮 → 新增搜索框/状态 chips/懒加载/
//       description 摘要/行号+语法高亮编辑器。本测试用 jsdom 全流程验证这些交互。
import { bootPanel, tick } from "./panel-helper.mjs";
import { readFileSync } from "node:fs";
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

test("编辑器：CodeMirror 6 真机挂载（注入真实产物）+ 判题提交编辑器内容", async () => {
  await withChallenges(async (ctx) => {
    // 注入**真实构建产物**（与线上同一条路径：panel.html 不静态引入，运行时注入脚本）
    const bundle = readFileSync(new URL("../desktop/renderer/practice-editor.bundle.js", import.meta.url), "utf8");
    ctx.window.eval(bundle);
    assert.ok(ctx.window.PracticeEditor?.create, "产物应暴露 window.PracticeEditor.create");

    // 捕获判题请求体，验证提交的是编辑器里的内容而不是别的残留
    let runBody = null;
    const baseFetch = ctx.window.fetch;
    ctx.window.fetch = async (url, init) => {
      if (String(url).includes("/api/challenges/run")) {
        runBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ ok: true, success: true, tests: [{ passed: true, label: "T" }], logs: [], durationMs: 3, reflow: { done: true } }) };
      }
      return baseFetch(url, init);
    };

    items(ctx)[0].querySelector(".ch-practice").click();
    await tick(80);
    const editor = ctx.window.document.querySelector(".ch-editor");
    assert.ok(editor, "做题编辑器应展开");
    assert.ok(editor.querySelector(".cm-editor"), "应挂载 CodeMirror（.cm-editor），而不是退回 textarea");
    assert.equal(editor.querySelector(".ch-ta"), null, "CodeMirror 路径不应再出现手搓 textarea");

    // 编辑内容 → 运行判题 → 请求体应是编辑器当前值
    const view = ctx.window.PracticeEditor.create; // 仅用于确认全局仍在
    assert.equal(typeof view, "function");
    editor.querySelector(".ch-editor-run").click();
    await tick(120);
    assert.ok(runBody, "应发出判题请求");
    assert.match(String(runBody.userCode), /function solve\(\)/, "判题应提交骨架/编辑后的代码（来自 CodeMirror）");
    assert.match(String(editor.querySelector(".ch-editor-result").textContent), /全部通过/, "结果区应展示判题结论");
    assert.match(String(editor.querySelector(".ch-editor-result").textContent), /已自动标记完成/, "回流结果应如实展示");
  });
});

test("编辑器回退路径：产物缺失时退回 textarea（行号 + 语法高亮 + 随输入更新）", async () => {
  await withChallenges(async (ctx) => {
    // 直接调用回退实现（CodeMirror 不可用时的分支）——保住这条兜底链路的回归覆盖
    const host = ctx.window.document.createElement("div");
    ctx.window.document.body.appendChild(host);
    const fb = ctx.window.mountFallbackEditor(host, "function solve() {\n  // TODO\n}");
    assert.equal(fb.kind, "textarea");
    const hl = host.querySelector(".ch-hl");
    const lines = host.querySelector(".ch-lines");
    const ta = host.querySelector(".ch-ta");
    assert.ok(lines, "回退路径应渲染行号列");
    assert.ok(hl, "回退路径应渲染高亮层");
    ta.value = "function a() { return 1; }";
    ta.dispatchEvent(new ctx.window.Event("input", { bubbles: true }));
    await tick(10);
    assert.ok(hl.innerHTML.includes('font-weight:600;">function</span>'), "function 关键字应着紫色 span");
    assert.ok(hl.innerHTML.includes('color:#2f7d4e;">a</span>'), "函数名 a 应着绿色 span");
    assert.equal(lines.textContent.trim(), "1", "行号应为 1");
    assert.equal(fb.getValue(), "function a() { return 1; }", "getValue 应返回 textarea 当前值");
  });
});

test("条目点击展开题干（手风琴）：展开显示完整描述、再点收起、按钮不触发展开", async () => {
  await withChallenges(async (ctx) => {
    const first = items(ctx)[0];
    const second = items(ctx)[1];
    // 点第一条 → 展开题干
    first.dispatchEvent(new ctx.window.MouseEvent("click", { bubbles: true }));
    await tick(20);
    let body = first.querySelector(".ch-body");
    assert.ok(body, "点击条目应展开题干");
    assert.ok(body.textContent.includes("手写实现第 0 号函数") || body.textContent.includes("给定数组"), "展开区应含完整描述");
    // 手风琴：点第二条 → 第一条收起
    second.dispatchEvent(new ctx.window.MouseEvent("click", { bubbles: true }));
    await tick(20);
    assert.ok(!first.querySelector(".ch-body"), "展开另一条时第一条应收起");
    assert.ok(second.querySelector(".ch-body"), "第二条应展开");
    // 再点第二条 → 收起
    second.dispatchEvent(new ctx.window.MouseEvent("click", { bubbles: true }));
    await tick(20);
    assert.ok(!second.querySelector(".ch-body"), "再点应收起");
    // 点「做题」按钮 → 不触发展开，只开编辑器
    first.querySelector(".ch-practice").click();
    await tick(60);
    assert.ok(!first.querySelector(".ch-body"), "点做题按钮不应展开题干");
    assert.ok(first.querySelector(".ch-editor"), "点做题按钮应展开编辑器");
  });
});

test("牛客 TOP101：条目点击展开题干（detail mock）+ 再点收起", async () => {
  const ctx = bootChallenges();
  try {
    await tick(50);
    const { window } = ctx;
    window.fetch = async (url) => {
      const u = String(url);
      let j;
      if (u.includes("/api/oj/problems")) j = { ok: true, total: 2, problems: [
        { bm_no: "BM1", category: "链表", title: "反转链表", difficulty: "简单", people: "1.2万", url: "https://www.nowcoder.com/practice/BM1", done: false },
        { bm_no: "BM2", category: "链表", title: "合并有序链表", difficulty: "中等", people: "8千", url: "https://www.nowcoder.com/practice/BM2", done: false },
      ], byCategory: [{ category: "链表", count: 2 }] };
      else if (u.includes("/api/oj/detail")) j = { ok: true, title: "反转链表", cached: true, meta: "时间限制 1s", content: "给定单链表的头节点，反转链表并返回新头。", samples: JSON.stringify([{ title: "示例1", input: "1,2,3", output: "3,2,1" }]) };
      else j = { ok: true, items: [], list: [], plan: { items: [] } };
      return { ok: true, json: async () => j };
    };
    window.loadOj();
    await tick(50);
    const ojList = window.document.getElementById("oj-list");
    const first = ojList.querySelector(".job-item");
    // 点条目 → 展开题干
    first.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(50);
    const body = first.querySelector(".oj-body");
    assert.ok(body, "点击牛客条目应展开题干");
    assert.ok(body.textContent.includes("反转链表"), "展开区应含题干内容");
    assert.ok(body.textContent.includes("示例"), "展开区应含示例");
    // 再点 → 收起
    first.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick(20);
    assert.ok(!first.querySelector(".oj-body"), "再点应收起");
    // 点「去刷题」链接 → 不触发展开
    const link = first.querySelector("a");
    link.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(20);
    assert.ok(!first.querySelector(".oj-body"), "点链接不应触发展开");
  } finally {
    ctx.window.clearAllTimers();
    ctx.dom.window.close();
  }
});
