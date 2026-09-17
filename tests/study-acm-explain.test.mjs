// 讲解按题目形态分流 + 题目↔清单闭环 护栏（2026-09-16）
// 背景（用户实测反馈）："学习清单对算法的讲解不好——LeetCode 题还凑合，我做的 ACM 笔试很难去做练习"。
// 根因两条，本文件各钉一组：
//   ① 讲解 prompt 里算法题一律要求"LeetCode 风格完整可运行的函数"（补全函数体）→ ACM 笔试题
//      （自己读输入/自己输出/多组用例/EOF）讲不到点上；
//   ② 清单条目与题库题目之间**没有通路**：条目不知道自己对应哪道题、也不知道题目形态，
//      于是既没法按形态讲、也没法从清单一键跳回去做题（实测 219 条清单里 0 条 ACM 题）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("study-acm-explain");
mockLLM();

const { explainPromptFor } = await import("../plugins/job-hunter/routes/study.ts");
const { isAcmStyle } = await import("../lib/ai.ts");
const { addChallengeToPlan, challengeTopicFor, getPlan } = await import("../lib/study.mjs");
const { importChallengesData } = await import("../lib/ai-career.ts");
const { registerPracticeRoutes } = await import("../plugins/job-hunter/routes/practice.ts");

const PROF = { scopeNote: "面试相关（从知识本身讲，不按方向定制）" };

test("isAcmStyle：显式 mode 优先；题面特征词（输入格式/多组输入/EOF/readline）兜底", () => {
  assert.equal(isAcmStyle("任意题", "acm"), true, "显式 mode=acm");
  assert.equal(isAcmStyle("A+B（多组输入直到 EOF）", ""), true, "题面含多组输入/EOF");
  assert.equal(isAcmStyle("求和\n输入格式：第一行 n\n输出格式：一行", "core"), true, "题面含输入/输出格式（mode 只是 core 也应识别）");
  assert.equal(isAcmStyle("区间和（多组询问）", ""), true);
  assert.equal(isAcmStyle("请用 readline() 逐行读入", ""), true, "题面提到 readline");
  assert.equal(isAcmStyle("手写防抖 debounce", "core"), false, "核心代码题不应判为 ACM");
  assert.equal(isAcmStyle("讲讲事件循环", ""), false, "普通知识题不应判为 ACM");
});

test("讲解分流：ACM 条目讲『可提交脚本/输入解析/多组 EOF/输出格式』，核心代码条目仍讲『完整讲解』", () => {
  const acm = explainPromptFor({ topic: "笔试题·A+B（多组输入直到 EOF）", mode: "acm", verify_question: "请按 ACM 模式完整讲解：A+B" }, PROF);
  assert.match(acm.title, /ACM/, "标题应点明 ACM 模式");
  assert.match(acm.text, /完整可提交的脚本/, "必须要求可提交的完整脚本（而不是补全函数）");
  assert.match(acm.text, /readline\(\)/, "必须交代本环境的读入约定");
  assert.match(acm.text, /EOF/, "必须讲多组/EOF 处理");
  assert.match(acm.text, /输出格式/, "必须讲输出格式与常见判错原因");
  assert.match(acm.text, /数据范围\s*→\s*复杂度/, "必须给数据范围→复杂度推理");
  assert.match(acm.text, /最容易踩的坑/, "必须列常见坑");

  const core = explainPromptFor({ topic: "手写题·防抖", mode: "core", verify_question: "手写防抖" }, PROF);
  assert.doesNotMatch(core.text, /完整可提交的脚本/, "核心代码条目不应被要求写完整脚本");
  assert.match(core.text, /请完整讲解/, "核心代码条目保持原口径");

  // 回归：项目条目仍是"项目剖析"（不能被本轮改动带偏）
  const proj = explainPromptFor({ topic: "项目·ai-career", verify_question: "" }, PROF);
  assert.match(proj.text, /技术选型 trade-off/, "项目条目：剖析框架不变");
});

test("题库 → 清单：ACM 题落成『笔试题·X』并带 challengeId/mode；幂等；核心代码题前缀不同", () => {
  const acm = addChallengeToPlan({ challengeId: "acm-a-plus-b", title: "A+B（多组输入直到 EOF）", mode: "acm", category: "algorithm", description: "输入格式：多行，每行两个整数" });
  assert.equal(acm.ok, true);
  assert.equal(acm.topic, "笔试题·A+B（多组输入直到 EOF）");
  assert.equal(acm.added, 1);
  const items = getPlan().items;
  const it = items.find((x) => x.topic === acm.topic);
  assert.ok(it, "条目应落库");
  assert.equal(it.challengeId, "acm-a-plus-b", "条目必须带题目 id（清单→做题闭环的依据）");
  assert.equal(it.mode, "acm", "条目必须带题目形态");
  assert.match(String(it.verify_question), /ACM 模式/, "verify_question 决定讲解提问口径");
  assert.match(String(it.why), /ACM 模式/, "why 里标明是笔试题形态");

  // 幂等：重复加入不产生第二条（保持原完成状态）
  const again = addChallengeToPlan({ challengeId: "acm-a-plus-b", title: "A+B（多组输入直到 EOF）", mode: "acm", category: "algorithm" });
  assert.equal(again.added, 0);
  assert.equal(again.existing, 1);
  assert.equal(getPlan().items.filter((x) => x.topic === acm.topic).length, 1, "不得重复条目");

  // 核心代码题：前缀按 category 区分（手写 / 算法）
  assert.equal(challengeTopicFor("防抖", "core", "handwrite"), "手写题·防抖");
  assert.equal(challengeTopicFor("二分查找", "core", "algorithm"), "算法题·二分查找");
  assert.equal(challengeTopicFor("A+B", "acm", "algorithm"), "笔试题·A+B");
});

test("路由闭环：/api/challenges/add-to-plan 落条目，/api/study-plan 能读回 challengeId/mode（契约不 strip）", async () => {
  importChallengesData([{
    id: "acm-route-1", title: "n 个数求和（单组）", category: "algorithm", mode: "acm",
    ioCases: [{ input: "3\n1 2 3", expected: "6" }], description: "输入格式：第一行 n，第二行 n 个整数。",
  }]);
  const router = createRouter();
  registerPracticeRoutes(router);
  const res = () => {
    const chunks = [];
    return { chunks, destroyed: false, writableEnded: false, status: 0,
      writeHead(c) { this.status = c; return this; }, write(c) { chunks.push(String(c)); return true; },
      end(c) { if (c !== undefined) chunks.push(String(c)); this.writableEnded = true; return this; }, on() {} };
  };
  const post = (path, body) => {
    const ls = {};
    return { method: "POST", url: path, headers: {}, destroyed: false,
      on(ev, fn) { ls[ev] = fn; if (ev === "end") setImmediate(() => { if (ls.data) ls.data(Buffer.from(JSON.stringify(body))); fn(); }); return this; }, destroy() {} };
  };
  const r1 = res();
  await router.resolve("/api/challenges/add-to-plan", "POST").fn(post("/api/challenges/add-to-plan", { id: "acm-route-1" }), r1, new URL("/api/challenges/add-to-plan", "http://x"));
  for (let i = 0; i < 200 && !r1.writableEnded; i++) await new Promise((r) => setTimeout(r, 10)); // readBody 异步：等响应落地
  const j1 = JSON.parse(r1.chunks.join(""));
  assert.equal(j1.ok, true, JSON.stringify(j1).slice(0, 200));
  assert.equal(j1.topic, "笔试题·n 个数求和（单组）");

  // 不存在的题 → 404（不假成功）
  const r2 = res();
  await router.resolve("/api/challenges/add-to-plan", "POST").fn(post("/api/challenges/add-to-plan", { id: "nope" }), r2, new URL("/api/challenges/add-to-plan", "http://x"));
  for (let i = 0; i < 200 && !r2.writableEnded; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(r2.status, 404);

  // 清单读取（同一数据层）：条目带 challengeId/mode
  const got = getPlan().items.find((x) => x.topic === j1.topic);
  assert.equal(got?.challengeId, "acm-route-1");
  assert.equal(got?.mode, "acm");
});

test("面板接线：题库有「加入清单」、清单有「去做题」+ 跨 Tab 跳转实现", async () => {
  const rest = await readFile(new URL("../desktop/renderer/panel-rest.js", import.meta.url), "utf8");
  assert.match(rest, /ch-addplan/, "题库列表应有「📚 加入清单」按钮");
  assert.match(rest, /\/api\/challenges\/add-to-plan/, "应调用加入清单路由");
  assert.match(rest, /async function gotoChallenge\(/, "应实现跨 Tab 跳转（清单→做题）");
  assert.match(rest, /chMode = String\(mode \|\| ""\) === "acm" \? "acm" : "core"/, "跳转时必须切到题目所属模式（否则 ACM 题不在列表里）");
  assert.match(rest, /item\.querySelector\("\.ch-practice"\)/, "跳转后应自动展开该题编辑器");
  const study = await readFile(new URL("../desktop/renderer/panel-study.js", import.meta.url), "utf8");
  assert.match(study, /s-goch/, "清单条目应有「✍️ 去做题」按钮（仅在关联题目时渲染）");
  assert.match(study, /it\.challengeId/, "按钮渲染应以 challengeId 为条件");
  assert.match(study, /gotoChallenge\(btn\.dataset\.cid, btn\.dataset\.mode\)/, "点击应带题目 id 与形态跳转");
});
