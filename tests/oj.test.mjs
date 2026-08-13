// oj 专项练习测试：TOP101 解析（parseOjDetail：预览卡跳过/字段值收集/数据范围多行）
// + collect/查询路径（Playwright 全部 mock，离线秒跑）：
//   collectOjProblems / getOjProblems / getOjStats / fetchOjDetail（含缓存）/ collectAllOjDetails
import { test, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("oj");

// ---------- Playwright mock（必须在 import oj.mjs 之前注册） ----------
// oj.mjs 内部是 await import("playwright") 动态导入。v22.19.0 不支持 bare specifier mock
// （22.20+/23.3+ 才有），所以用 import.meta.resolve 解析出的真实模块文件 URL 注册 mock
// （与 helpers.mjs mockLLM/mockFetchPage 同款按文件 URL 拦截的方式）。
const PW_URL = import.meta.resolve("playwright");

// 每测试预设：page.evaluate 的返回值（题目行数组 / 详情页 innerText / Error → evaluate 抛错）
let fakeEvalResult = [];
let launchCount = 0;      // chromium.launch 调用次数
let newContextCount = 0;  // browser.newContext 调用次数
let evalCallCount = 0;    // page.evaluate 调用次数

function makeFakePage() {
  return {
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => {
      evalCallCount++;
      if (fakeEvalResult instanceof Error) throw fakeEvalResult;
      return fakeEvalResult;
    },
  };
}

const fakeCtx = { newPage: async () => makeFakePage(), close: async () => {} };
const fakeBrowser = {
  newContext: async () => { newContextCount++; return fakeCtx; },
  close: async () => {},
};
const fakeChromium = { launch: async () => { launchCount++; return fakeBrowser; } };

mock.module(PW_URL, { namedExports: { chromium: fakeChromium } });

const oj = await import("../lib/oj.mjs");
const { db } = await import("../lib/db.mjs");

// 模拟真实牛客详情页 innerText：顶部预览卡（无"描述"锚点）+ 正式题目区
const REAL_PAGE = `反转链表_牛客题霸_牛客网
给定一个单链表的头结点pHead，长度为n，反转该链表。
示例1
输入
{1,2,3}
输出
{3,2,1}
示例2
输入
{}
输出
{}
说明
空链表则输出空
BM1 反转链表
题目
题解(1k)
讨论(3k)
简单  通过率：40.19%  时间限制：1秒  空间限制：256M
知识点
链表
描述
给定一个单链表的头结点pHead(该头节点是有值的)，长度为n，反转该链表后，返回新链表的表头。
数据范围：
0
≤
n
≤
1000
要求：空间复杂度 O(1) ，时间复杂度 O(n)。
示例1
输入：
{1,2,3}
复制
返回值：
{3,2,1}
复制
示例2
输入：
{}
复制
返回值：
{}
复制
说明：
空链表则输出空
关联企业
字节`;

// 题目清单 mock 数据（分类标题行解析产物）
const P3 = [
  { category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "40.2w", href: "https://www.nowcoder.com/practice/pcKA7m8z7a" },
  { category: "链表", bm_no: "BM2", title: "链表内指定区间反转", difficulty: "中等", people: "30.1w", href: "https://www.nowcoder.com/practice/xxx2" },
  { category: "二叉树", bm_no: "BM1", title: "二叉树的前序遍历", difficulty: "简单", people: "50.5w", href: "https://www.nowcoder.com/practice/xxx3" },
];

test("parseOjDetail 真实页面格式：跳过预览卡、字段带冒号、多行值收集", () => {
  const r = oj.parseOjDetail(REAL_PAGE);
  assert.equal(r.meta, "简单  通过率：40.19%  时间限制：1秒  空间限制：256M", "元信息行");
  assert.ok(r.description.includes("反转该链表后，返回新链表的表头"), "正式区题干（非预览卡）");
  assert.ok(r.description.includes("数据范围：\n0\n≤\nn\n≤\n1000"), "数据范围多行保留");
  assert.equal(r.samples.length, 2, "只收正式区示例（预览卡跳过）");
  assert.deepEqual(r.samples[0], { title: "示例1", input: "{1,2,3}", output: "{3,2,1}", note: "" });
  assert.deepEqual(r.samples[1], { title: "示例2", input: "{}", output: "{}", note: "空链表则输出空" });
});

test("parseOjDetail 空/畸形输入安全", () => {
  const r1 = oj.parseOjDetail("");
  assert.equal(r1.description, "");
  assert.equal(r1.samples.length, 0);
  const r2 = oj.parseOjDetail(null);
  assert.equal(r2.description, "");
});

// ---------- collect/查询路径（Playwright mock） ----------
beforeEach(async () => {
  await clearAllTables(); // 隔离其他表（helpers.mjs 只读，exam_problems 不在其清单内）
  db.prepare("DELETE FROM exam_problems").run();
  fakeEvalResult = [];
  launchCount = 0;
  newContextCount = 0;
  evalCallCount = 0;
});

test("collectOjProblems 解析题目行入库：计数正确 + id=oj_分类_BM号 + 字段落库", async () => {
  fakeEvalResult = P3;
  const r = await oj.collectOjProblems();
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.equal(r.added, 3);
  assert.equal(r.updated, 0);
  const rows = db.prepare("SELECT * FROM exam_problems ORDER BY category, bm_no").all();
  assert.equal(rows.length, 3);
  assert.ok(rows.some((x) => x.id === "oj_链表_BM1"), "id 格式 oj_分类_BM号");
  assert.ok(rows.some((x) => x.id === "oj_链表_BM2"));
  assert.ok(rows.some((x) => x.id === "oj_二叉树_BM1"));
  const bm1 = rows.find((x) => x.category === "链表" && x.bm_no === "BM1");
  assert.equal(bm1.title, "反转链表");
  assert.equal(bm1.difficulty, "简单");
  assert.equal(bm1.people, "40.2w");
  assert.equal(bm1.url, "https://www.nowcoder.com/practice/pcKA7m8z7a");
});

test("collectOjProblems 幂等：重复抓取最终态一致（全量刷新）；批内同键触发 upsert 更新计数", async () => {
  fakeEvalResult = P3;
  const r1 = await oj.collectOjProblems();
  const r2 = await oj.collectOjProblems();
  assert.equal(r1.added, 3);
  assert.equal(r2.ok, true);
  assert.equal(r2.total, 3);
  // 全量刷新是 DELETE 后重插：重复抓取仍计 added=总数，但最终表状态幂等（无残留/无重复）
  assert.equal(r2.added, 3);
  assert.equal(r2.updated, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM exam_problems").get().n, 3, "重复抓取不产生重复行");
  // 数据变化后旧分类/旧行不残留（全量刷新语义）
  fakeEvalResult = [{ category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "41.0w", href: "https://www.nowcoder.com/practice/pcKA7m8z7a" }];
  const r3 = await oj.collectOjProblems();
  assert.equal(r3.total, 1);
  const rows = db.prepare("SELECT category, bm_no, people FROM exam_problems").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].people, "41.0w", "同键数据更新");
  assert.ok(!rows.some((x) => x.category === "二叉树"), "旧分类行被清");
  // 批内同键重复（evaluate 返回两个相同 category+bm_no 的行）→ ON CONFLICT 更新 + updated 计数
  fakeEvalResult = [
    { category: "链表", bm_no: "BM1", title: "A", difficulty: "简单", people: "1w", href: "u1" },
    { category: "链表", bm_no: "BM1", title: "B", difficulty: "简单", people: "2w", href: "u2" },
  ];
  const r4 = await oj.collectOjProblems();
  assert.equal(r4.total, 2);
  assert.equal(r4.added, 1);
  assert.equal(r4.updated, 1, "批内同键第二次命中 existed → updated");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM exam_problems").get().n, 1, "同键冲突只留一行");
  assert.equal(db.prepare("SELECT title FROM exam_problems WHERE id='oj_链表_BM1'").get().title, "B", "ON CONFLICT 更新为新值");
});

test("collectOjProblems 空提取：报错页面结构变化，且不清空已有数据（早退保护）", async () => {
  fakeEvalResult = P3;
  await oj.collectOjProblems();
  fakeEvalResult = [];
  const r = await oj.collectOjProblems();
  assert.equal(r.ok, false);
  assert.equal(r.total, 0);
  assert.ok(r.error.includes("页面结构变化"), "错误信息");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM exam_problems").get().n, 3, "提取失败不误清已有题库");
});

test("getOjProblems 查询：默认排序 / category 过滤 / difficulty LIKE / limit / 字段 String 化", async () => {
  fakeEvalResult = [
    { category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "40.2w", href: "u1" },
    { category: "链表", bm_no: "BM2", title: "区间反转", difficulty: "中等", people: "30.1w", href: "u2" },
    { category: "链表", bm_no: "BM3", title: "链表中环的入口", difficulty: "简单", people: "25.4w", href: "u3" },
    { category: "二叉树", bm_no: "BM1", title: "前序遍历", difficulty: "简单", people: "50.5w", href: "u4" },
    { category: "二叉树", bm_no: "BM2", title: "中序遍历", difficulty: "中等", people: "", href: "u5" },
  ];
  await oj.collectOjProblems();
  const all = oj.getOjProblems();
  assert.equal(all.length, 5);
  const got = all.map((x) => `${x.category}:${x.bm_no}`);
  const sorted = [...got].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assert.deepEqual(got, sorted, "默认按 category, bm_no 排序");
  const cats = oj.getOjProblems({ category: "链表" });
  assert.equal(cats.length, 3);
  assert.ok(cats.every((x) => x.category === "链表"));
  const diffs = oj.getOjProblems({ difficulty: "简" });
  assert.equal(diffs.length, 3, "difficulty LIKE '简%'");
  assert.ok(diffs.every((x) => x.difficulty.startsWith("简")));
  assert.equal(oj.getOjProblems({ limit: 2 }).length, 2, "limit 生效");
  for (const x of all) {
    for (const k of ["category", "bm_no", "title", "difficulty", "people", "url"]) {
      assert.equal(typeof x[k], "string", `字段 ${k} 转 String`);
    }
  }
  assert.equal(all[1].people, "", "空 people 不串成 null");
});

test("getOjStats 统计：total / byCategory 按 n 降序 / byDifficulty 分组", async () => {
  fakeEvalResult = P3; // 链表×2（简单+中等）、二叉树×1（简单）
  await oj.collectOjProblems();
  const s = oj.getOjStats();
  assert.equal(s.total, 3);
  assert.deepEqual(s.byCategory, [
    { category: "链表", count: 2 },
    { category: "二叉树", count: 1 },
  ], "byCategory 按 n DESC");
  const byDiff = [...s.byDifficulty].sort((a, b) => b.count - a.count);
  assert.deepEqual(byDiff, [
    { difficulty: "简单", count: 2 },
    { difficulty: "中等", count: 1 },
  ], "byDifficulty 分组");
});

test("fetchOjDetail 首次抓取解析入库；二次调用命中缓存（evaluate/newContext 不再触发）", async () => {
  const url = "https://www.nowcoder.com/practice/pcKA7m8z7a";
  fakeEvalResult = [{ category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "40.2w", href: url }];
  await oj.collectOjProblems();
  fakeEvalResult = REAL_PAGE;
  const evalsAfterCollect = evalCallCount; // collect 已调 1 次 evaluate
  const ctxAfterCollect = newContextCount;
  const r1 = await oj.fetchOjDetail(url);
  assert.equal(r1.ok, true);
  assert.equal(r1.cached, false);
  assert.equal(r1.meta, "简单  通过率：40.19%  时间限制：1秒  空间限制：256M", "元信息");
  assert.ok(r1.content.includes("反转该链表后，返回新链表的表头"), "题干");
  assert.equal(evalCallCount, evalsAfterCollect + 1, "首次抓取调 evaluate 1 次");
  assert.equal(newContextCount, ctxAfterCollect + 1, "首次抓取开 1 个 context");
  const row = db.prepare("SELECT content, meta, samples, fetched_at FROM exam_problems WHERE url=?").get(url);
  assert.ok(row.fetched_at > 0, "fetched_at 已更新");
  assert.ok(row.content.includes("反转该链表后"), "content 入库");
  assert.ok(row.meta.length > 0, "meta 入库");
  assert.equal(JSON.parse(row.samples).length, 2, "samples 入库（JSON）");
  const r2 = await oj.fetchOjDetail(url);
  assert.equal(r2.ok, true);
  assert.equal(r2.cached, true, "缓存命中");
  assert.equal(r2.content, r1.content, "缓存内容一致");
  assert.equal(newContextCount, ctxAfterCollect + 1, "缓存命中不再开 context");
  assert.equal(evalCallCount, evalsAfterCollect + 1, "缓存命中不再调 evaluate");
});

test("fetchOjDetail 解析失败：无描述/无元信息 → 报错且不写缓存", async () => {
  const url = "https://www.nowcoder.com/practice/pcKA7m8z7a";
  fakeEvalResult = [{ category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "40.2w", href: url }];
  await oj.collectOjProblems();
  fakeEvalResult = "一堆没有描述的文本\n没有任何元信息行";
  const r = await oj.fetchOjDetail(url);
  assert.equal(r.ok, false);
  assert.ok(r.error.includes("详情页解析失败"), "错误信息");
  const row = db.prepare("SELECT content, fetched_at FROM exam_problems WHERE url=?").get(url);
  assert.equal(row.content, "", "不写入 content");
  assert.equal(row.fetched_at, 0, "不标记已抓取");
});

test("fetchOjDetail url 为空/缺失 → url required", async () => {
  const r1 = await oj.fetchOjDetail("");
  assert.equal(r1.ok, false);
  assert.equal(r1.error, "url required");
  const r2 = await oj.fetchOjDetail(null);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, "url required");
});

test("collectAllOjDetails 批量下载：pending 只算未抓取、进度回调、done/failed 计数", async () => {
  fakeEvalResult = P3;
  await oj.collectOjProblems();
  // 二叉树BM1 已抓取（fetched_at>0 且 content 非空）→ 不算 pending
  db.prepare("UPDATE exam_problems SET fetched_at=1, content='已缓存正文', meta='已缓存元信息' WHERE category='二叉树' AND bm_no='BM1'").run();
  fakeEvalResult = REAL_PAGE;
  const progress = [];
  const r = await oj.collectAllOjDetails((done, total, title) => progress.push({ done, total, title }));
  assert.equal(r.ok, true);
  assert.equal(r.total, 2, "pending 只算未抓取的 2 条（fetched_at=0 OR content=''）");
  assert.equal(r.done, 2);
  assert.equal(r.failed, 0);
  assert.equal(progress.length, 2, "进度回调 2 次");
  assert.deepEqual(progress.map((p) => p.total), [2, 2], "回调 total=2");
  assert.deepEqual(progress.map((p) => p.done), [1, 2], "回调进度递增");
  assert.equal(progress[0].title, "反转链表", "回调带标题");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM exam_problems WHERE fetched_at>0").get().n, 3, "全部题目已抓取");
});

test("collectAllOjDetails evaluate 抛错：单条失败计入 failed，整体 ok", async () => {
  fakeEvalResult = [
    { category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "40.2w", href: "u1" },
    { category: "链表", bm_no: "BM2", title: "区间反转", difficulty: "中等", people: "30.1w", href: "u2" },
  ];
  await oj.collectOjProblems();
  fakeEvalResult = new Error("playwright evaluate 抛错（模拟页面异常）");
  const r = await oj.collectAllOjDetails();
  assert.equal(r.ok, true);
  assert.equal(r.total, 2);
  assert.equal(r.done, 0);
  assert.equal(r.failed, 2, "evaluate 异常计入 failed");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM exam_problems WHERE fetched_at>0").get().n, 0, "失败不写缓存");
});

test("collectAllOjDetails 全部已缓存：allCached:true 且不启动浏览器/不调 evaluate", async () => {
  fakeEvalResult = [{ category: "链表", bm_no: "BM1", title: "反转链表", difficulty: "简单", people: "40.2w", href: "u1" }];
  await oj.collectOjProblems();
  db.prepare("UPDATE exam_problems SET fetched_at=1, content='已缓存', meta='m' WHERE bm_no='BM1'").run();
  const launchesBefore = launchCount;
  const evalsBefore = evalCallCount;
  let progressCalls = 0;
  const r = await oj.collectAllOjDetails(() => progressCalls++);
  assert.equal(r.ok, true);
  assert.equal(r.total, 0);
  assert.equal(r.allCached, true);
  assert.equal(launchCount, launchesBefore, "无 pending 不启动浏览器");
  assert.equal(evalCallCount, evalsBefore, "无 pending 不调 evaluate");
  assert.equal(progressCalls, 0, "无 pending 不回调");
});

cleanupTempDb(dbDir);
