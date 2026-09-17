// 题面解析 + 题目身份（按 id 认亲）+ 自定义笔试题录入 护栏（2026-09-16）
// 用户提问："题目解析你做了吗？LeetCode 的题好歹一句话，ACM 的题都复杂一点，只看题目能正确匹配吗？"
// 查证结论（本文件把这些钉死）：
//   ① 题面解析：ACM 题面是长文本（题目/输入格式/输出格式/多组样例/数据范围），**样例是天然判题用例**；
//      原先只是把整段塞给 LLM，样例没被结构化 → 无法判题、讲解也拿不到结构。
//   ② 身份匹配：原先清单/复习卡/讲解存档都靠 **topic 字符串 + 相似度**；实测
//      isSimilarTopicForArchive("n 个数求和（单组）","n 个数求和") = true → 标题只差一个括号的两道题会被并成一条。
//      现在带题目 id 的条目/卡片**只认 id**（不同 id 绝不合并）。
//   ③ 录入入口：真实做过的笔试题在牛客/赛码上，本地没有那道题 → 粘题面即可变成"可做题、可讲、可加清单"的题。
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, mockLLM } from "./helpers.mjs";
import { createRouter } from "../lib/routes/router.mjs";

setupTempDb("acm-statement");
mockLLM();

const { parseStatement, looksLikeAcmStatement } = await import("../lib/acm-statement.ts");
const { isSimilarTopicForArchive } = await import("../lib/memory.mjs");
const { review } = await import("../lib/review.mjs");
const { addChallengeToPlan, getPlan } = await import("../lib/study.mjs");
const { importChallengesData, markChallengeWrong, getChallengeDetail } = await import("../lib/ai-career.ts");
const { registerPracticeRoutes } = await import("../plugins/job-hunter/routes/practice.ts");

const STATEMENT = `小真在整理教室排课表，需要你帮忙统计。

输入格式：
第一行两个整数 n 和 q。
第二行 n 个整数 a[i]。
接下来 q 行，每行两个整数 l r。

输出格式：
共 q 行，每行一个整数表示区间和。

样例输入：
5 2
1 2 3 4 5
1 3
2 5

样例输出：
6
14

样例输入：
3 1
10 20 30
3 3

样例输出：
30

数据范围：
1 <= n, q <= 100000，1 <= a[i] <= 1000。`;

test("题面解析：切出输入/输出格式、数据范围，并把每组样例配成可判题用例", () => {
  const p = parseStatement(STATEMENT);
  assert.match(p.inputFormat, /第一行两个整数/, "应解析出输入格式段");
  assert.match(p.outputFormat, /共 q 行/, "应解析出输出格式段");
  assert.match(p.constraints, /100000/, "应解析出数据范围段");
  assert.equal(p.samples.length, 2, `应解析出 2 组样例（实得 ${p.samples.length}）`);
  assert.equal(p.samples[0].input, "5 2\n1 2 3 4 5\n1 3\n2 5");
  assert.equal(p.samples[0].expected, "6\n14");
  assert.equal(p.samples[1].input, "3 1\n10 20 30\n3 3");
  assert.equal(p.samples[1].expected, "30", "多组样例必须分别配对（不能把第二组样例并进第一组）");
  assert.equal(looksLikeAcmStatement(STATEMENT), true);
  assert.equal(looksLikeAcmStatement("写一个防抖函数"), false, "普通题面不应判为 ACM");
  // 坏输入不抛错
  assert.deepEqual(parseStatement("").samples, []);
  assert.deepEqual(parseStatement(null).samples, []);
});

test("身份按题目 id：标题只差一个括号的两道题，清单与复习卡都必须各算各的", () => {
  // 先确认这个风险是真实的（相似度确实会把它们判成同一题）
  assert.equal(isSimilarTopicForArchive("n 个数求和（单组）", "n 个数求和"), true, "前提：相似度判定确实会误并（护栏才有意义）");

  const a = addChallengeToPlan({ challengeId: "acm-sum-n", title: "n 个数求和（单组）", mode: "acm", category: "algorithm" });
  const b = addChallengeToPlan({ challengeId: "acm-sum-n-simple", title: "n 个数求和", mode: "acm", category: "algorithm" });
  assert.equal(a.added, 1);
  assert.equal(b.added, 1, "标题高度相似但 id 不同 → 必须是两条清单条目（不能相似合并）");
  const items = getPlan().items.filter((x) => x.challengeId);
  assert.equal(items.length, 2, `应两条带题目 id 的条目（实得 ${items.length}）`);
  // 幂等按 id：**同 id 即使标题变了也不重复**（这条例行才真正吃 id 优先判重——
  // 若退回"按 topic 判重"，改标题后再加就会多出一条，同一道题在清单里出现两次）
  const again = addChallengeToPlan({ challengeId: "acm-sum-n", title: "n 个数求和（单组，改过标题）", mode: "acm", category: "algorithm" });
  assert.equal(again.existing, 1, "同题目 id 应命中原条目（existing=1）");
  assert.equal(again.added, 0, "不得因标题变化重复加条目");
  assert.equal(getPlan().items.filter((x) => x.challengeId === "acm-sum-n").length, 1, "同一道题在清单里只能有一条");

  // 复习卡同理：**必须挑一对"相似度真的会合并"的标题**（上面已断言 isSimilarTopicForArchive 为 true），
  // 否则护栏是假绿——去掉 id 认亲也照样绿（实测第一版就踩到：A+B 那对差异够大，压根不会合并）
  const t1 = "笔试题·n 个数求和（单组）", t2 = "笔试题·n 个数求和";
  assert.equal(isSimilarTopicForArchive(t1, t2), true, "前提：这两个 topic 会被相似合并（护栏才有意义）");
  const c1 = review.addCard({ topic: t1, question: "q1", source: "ACM 笔试题库", challengeId: "acm-sum-n" });
  const c2 = review.addCard({ topic: t2, question: "q2", source: "ACM 笔试题库", challengeId: "acm-sum-n-simple" });
  assert.notEqual(c1?.id, c2?.id, "不同题目 id → 必须两张卡（不能被相似合并成一张）");
  // 同 id 再建 → 命中同一张（幂等；卡片按 id 认亲而不是靠标题）
  const c1again = review.addCard({ topic: t1, question: "q1b", source: "ACM 笔试题库", challengeId: "acm-sum-n" });
  assert.equal(c1again?.id, c1?.id, "同 id 应命中同一张卡");
  // 无 id 的纯知识点卡仍走相似合并（原有防"漂移卡分裂"能力不能被本次改动破坏）
  const k1 = review.addCard({ topic: "手写防抖 debounce", question: "a", source: "t" });
  const k2 = review.addCard({ topic: "手写防抖 debounce 实现", question: "b", source: "t" });
  assert.equal(k1?.id, k2?.id, "不带题目 id 的卡片仍应相似合并（回归）");
});

test("答错回流：ACM 题答错建卡用「笔试题·」前缀 + 落 challenge_id（不再一律叫手写题）", () => {
  importChallengesData([{ id: "acm-bracket-match", title: "括号匹配判定", category: "algorithm", mode: "acm", ioCases: [{ input: "()", expected: "YES" }] }]);
  markChallengeWrong("acm-bracket-match");
  const card = review.loadCards().cards.find((c) => String(c.challengeId || "") === "acm-bracket-match");
  assert.ok(card, "应建出一张带 challenge_id 的卡");
  assert.equal(card.topic, "笔试题·括号匹配判定", "ACM 题的卡前缀应是「笔试题·」");
  assert.equal(card.source, "ACM 笔试题库", "来源如实标注");
});

test("录入路由：粘贴题面 → 解析样例入库（mode=acm）→ 详情能读出用例；无样例时如实警告", async () => {
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
  const call = async (path, body) => {
    const r = res();
    await router.resolve(path, "POST").fn(post(path, body), r, new URL(path, "http://x"));
    for (let i = 0; i < 200 && !r.writableEnded; i++) await new Promise((x) => setTimeout(x, 10));
    return { status: r.status, json: JSON.parse(r.chunks.join("") || "{}") };
  };

  const r1 = await call("/api/challenges/import-custom", { title: "区间和（录入测试）", statement: STATEMENT });
  assert.equal(r1.json.ok, true, JSON.stringify(r1.json).slice(0, 200));
  assert.equal(r1.json.samples, 2, "应把 2 组样例落成判题用例");
  assert.equal(r1.json.hasInputFormat, true);
  assert.equal(r1.json.hasConstraints, true);
  assert.equal(r1.json.warning, null);
  const detail = getChallengeDetail(r1.json.id);
  assert.equal(detail.mode, "acm");
  assert.equal(detail.ioCases.length, 2, "详情应读回用例（可直接判题）");
  assert.match(detail.description, /解析出的输入格式/, "题面里保留解析结果（讲解/复习可用）");

  // 没有样例 → 不假装可判题，明确警告
  const r2 = await call("/api/challenges/import-custom", { title: "无样例题", statement: "题目描述：求两数之和。\n输入格式：一行两个整数。" });
  assert.equal(r2.json.ok, true);
  assert.equal(r2.json.samples, 0);
  assert.match(String(r2.json.warning), /没解析出/, "无样例必须如实警告");
  // 空题面 → 400
  const r3 = await call("/api/challenges/import-custom", { statement: "" });
  assert.equal(r3.status, 400);
});

test("面板接线：录入入口 + 走页内多行浮层（Electron 不能用 prompt）", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../desktop/renderer/panel.html", import.meta.url), "utf8");
  assert.match(html, /id="challenge-import-btn"/, "题库工具栏应有「➕ 录入笔试题」");
  const rest = await readFile(new URL("../desktop/renderer/panel-rest.js", import.meta.url), "utf8");
  assert.match(rest, /\/api\/challenges\/import-custom/, "应调用录入路由");
  assert.match(rest, /multiline: true/, "题面是多行长文本 → 必须用 __askText 的 multiline");
  // 注意：断言前先剥掉**整行注释**——panel-rest.js 里有一句历史说明"原用 window.prompt() 收集题干"，
  // 直接对全文做 doesNotMatch 会被注释误伤（子代理们此前踩过同款"注释/子串蒙混"的坑）。
  const restCode = rest.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.doesNotMatch(restCode, /window\.prompt\(/, "渲染层代码不得调用 window.prompt（Electron 会抛异常）");
  assert.match(rest, /gotoChallenge\(j\.id, "acm"\)/, "录入后应跳到该题（立刻可做题）");
});
