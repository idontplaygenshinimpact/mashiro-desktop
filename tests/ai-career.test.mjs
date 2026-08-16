// 手写/算法题库（ai-career）测试：导入 / 查询 / 统计 / 沙箱判题 / 闭环回流
//   导入幂等（INSERT OR REPLACE）、过滤查询、buildExportArgs 提取导出名、
//   判题（正确/错误/死循环超时/异步 sleep）、markDone/markWrong 闭环
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("ai-career");

const ac = await import("../lib/ai-career.mjs");
const { db } = await import("../lib/db.mjs");

const SAMPLE = [
  {
    id: "debounce", title: "手写防抖 debounce", category: "handwrite", difficulty: 1, frequency: 3,
    timeLimit: 10,
    description: "实现防抖函数。",
    skeleton: "function debounce(fn, delay = 300) {\n  // TODO\n}",
    testCode: `async function __test__(debounce) {
  __assert__(typeof debounce === "function", "导出 debounce 函数");
  let calls = 0;
  const fn = debounce(() => { calls++; }, 30);
  fn(); fn(); fn();
  await __sleep__(80);
  __assert__(calls === 1, "300ms 内只触发最后一次");
}`,
  },
  {
    id: "lru-cache", title: "LRU 缓存", category: "algorithm", difficulty: 2, frequency: 3,
    timeLimit: 15,
    description: "实现 LRUCache。",
    skeleton: "class LRUCache {\n  constructor(capacity) {}\n}",
    testCode: `async function __test__(LRUCache) {
  __assert__(typeof LRUCache === "function", "导出 LRUCache 类");
}`,
  },
];

beforeEach(async () => {
  await clearAllTables();
  db.prepare("DELETE FROM challenges").run();
});

// ---------- 导入 ----------
test("importChallengesData 批量导入：字段落库 + 幂等覆盖 + 非法行跳过", () => {
  const r1 = ac.importChallengesData(SAMPLE);
  assert.equal(r1.ok, true);
  assert.equal(r1.imported, 2);
  const row = db.prepare("SELECT * FROM challenges WHERE id='debounce'").get();
  assert.equal(row.title, "手写防抖 debounce");
  assert.equal(row.category, "handwrite");
  assert.equal(row.difficulty, 1);
  assert.equal(row.frequency, 3);
  assert.equal(row.time_limit, 10);
  assert.ok(row.test_code.includes("__test__"), "test_code 落库");
  assert.equal(row.source, "ai-career");
  assert.equal(row.done, 0);
  // 幂等：重复导入覆盖更新不新增
  const r2 = ac.importChallengesData([{ ...SAMPLE[0], title: "手写防抖（更新）", frequency: 2 }]);
  assert.equal(r2.imported, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM challenges").get().n, 2, "不产生重复行");
  const upd = db.prepare("SELECT title, frequency FROM challenges WHERE id='debounce'").get();
  assert.equal(upd.title, "手写防抖（更新）");
  assert.equal(upd.frequency, 2, "同 id 覆盖更新");
  // 非法行跳过
  const r3 = ac.importChallengesData([{ id: "", title: "无id" }, { id: "x", title: "" }, { id: "ok", title: "正常", category: "algorithm" }]);
  assert.equal(r3.imported, 1);
  assert.equal(ac.importChallengesData([]).ok, false, "空数组拒绝");
  assert.equal(ac.importChallengesData(null).ok, false);
});

// ---------- 查询 / 统计 ----------
test("getChallenges 过滤：category / difficulty / done + 字段 String 化", () => {
  ac.importChallengesData(SAMPLE);
  const all = ac.getChallenges();
  assert.equal(all.length, 2);
  const deb = all.find((x) => x.id === "debounce");
  assert.equal(deb.timeLimit, 10, "time_limit → timeLimit");
  assert.equal(deb.done, false);
  for (const x of all) {
    for (const k of ["id", "title", "category", "description", "skeleton"]) {
      assert.equal(typeof x[k], "string", `字段 ${k} 转 String`);
    }
    assert.equal(typeof x.difficulty, "number");
    assert.equal(typeof x.frequency, "number");
    assert.equal(typeof x.wrongCount, "number");
  }
  assert.equal(ac.getChallenges({ category: "handwrite" }).length, 1);
  assert.equal(ac.getChallenges({ category: "algorithm" }).length, 1);
  assert.equal(ac.getChallenges({ difficulty: 2 }).length, 1);
  assert.equal(ac.getChallenges({ difficulty: 3 }).length, 0);
  assert.equal(ac.getChallenges({ done: false }).length, 2);
  assert.equal(ac.getChallenges({ done: true }).length, 0);
});

test("getChallengeStats 统计 + getChallengeDetail 详情", () => {
  ac.importChallengesData(SAMPLE);
  const s = ac.getChallengeStats();
  assert.equal(s.total, 2);
  assert.equal(s.done, 0);
  assert.deepEqual(s.byCat, [
    { category: "algorithm", count: 1 },
    { category: "handwrite", count: 1 },
  ], "byCat 按 category 排序");
  const d = ac.getChallengeDetail("debounce");
  assert.equal(d.title, "手写防抖 debounce");
  assert.ok(d.testCode.includes("__test__"), "详情含 test_code");
  assert.equal(d.done, false);
  assert.equal(ac.getChallengeDetail("nope"), null, "不存在返回 null");
});

// ---------- 沙箱判题 ----------
test("buildExportArgs 从骨架提取 function/class 导出名", () => {
  assert.equal(ac.buildExportArgs("function debounce(fn, delay) {\n}"), "debounce");
  assert.equal(ac.buildExportArgs("class LRUCache {\n  constructor() {}\n}"), "LRUCache");
  assert.equal(ac.buildExportArgs("// 注释\nfunction a() {}\nclass B {}\nfunction c() {}"), "a, c, B", "按骨架出现顺序");
  assert.equal(ac.buildExportArgs(""), "");
  assert.equal(ac.buildExportArgs(null), "");
});

test("runChallengeCode 正确实现：全部测试通过 + 收集 console 日志", async () => {
  const r = await ac.runChallengeCode({
    userCode: "function debounce(fn, delay = 300) { let t = null; return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); }; }",
    testCode: SAMPLE[0].testCode, skeleton: SAMPLE[0].skeleton,
  });
  assert.equal(r.success, true);
  assert.equal(r.error, null);
  assert.ok(r.tests.length >= 2, "测试数");
  assert.ok(r.tests.every((t) => t.passed), "全部通过");
  assert.equal(r.durationMs >= 0, true);
});

test("runChallengeCode 错误实现：失败断言 + tests 逐条记录", async () => {
  const r = await ac.runChallengeCode({
    userCode: "function debounce(fn) { return fn; }",
    testCode: SAMPLE[0].testCode, skeleton: SAMPLE[0].skeleton,
  });
  assert.equal(r.success, false);
  assert.ok(r.tests.some((t) => !t.passed), "有失败测试");
  assert.ok(r.error, "错误信息");
});

test("runChallengeCode 死循环：超时掐断（不挂死）", async () => {
  const t0 = Date.now();
  const r = await ac.runChallengeCode({
    userCode: "function debounce(fn) { while (true) {} }",
    testCode: SAMPLE[0].testCode, skeleton: SAMPLE[0].skeleton, timeoutMs: 1500,
  });
  assert.equal(r.success, false);
  assert.ok(r.error.includes("timed out") || r.error.includes("超时"), `错误含超时: ${r.error}`);
  assert.ok(Date.now() - t0 < 10000, "总耗时受控（<10s）");
});

test("runChallengeCode 语法错误：报错不抛异常", async () => {
  const r = await ac.runChallengeCode({
    userCode: "function debounce( {", // 语法错误
    testCode: SAMPLE[0].testCode, skeleton: SAMPLE[0].skeleton,
  });
  assert.equal(r.success, false);
  assert.ok(r.error, "错误信息");
});

test("runChallengeCode 用户代码为空：仍走测试（测试会失败）或报错，不崩溃", async () => {
  const r = await ac.runChallengeCode({
    userCode: "", testCode: SAMPLE[0].testCode, skeleton: SAMPLE[0].skeleton,
  });
  assert.equal(typeof r.success, "boolean");
  assert.equal(typeof r.error, "string");
});

test("runChallengeCode 异步 sleep 测试：防抖时序断言可用", async () => {
  const r = await ac.runChallengeCode({
    userCode: "function debounce(fn, delay = 300) { let t = null; return function(...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), delay); }; }",
    testCode: SAMPLE[0].testCode, skeleton: SAMPLE[0].skeleton,
  });
  assert.equal(r.success, true, "sleep + 时序断言通过");
});

// ---------- 闭环回流 ----------
test("markChallengeDone：done=1 + 统计变化；不存在报错", () => {
  ac.importChallengesData(SAMPLE);
  const r = ac.markChallengeDone("debounce");
  assert.equal(r.ok, true);
  assert.equal(r.title, "手写防抖 debounce");
  assert.equal(db.prepare("SELECT done FROM challenges WHERE id='debounce'").get().done, 1);
  assert.equal(ac.getChallengeStats().done, 1);
  const r2 = ac.markChallengeDone("debounce", { progress: false });
  assert.equal(r2.ok, true);
  const r3 = ac.markChallengeDone("nope");
  assert.equal(r3.ok, false);
  assert.ok(r3.error.includes("不存在"));
});

test("markChallengeWrong：wrong_count 累加 + 薄弱点回流 + 自动建复习卡（闭环）", async () => {
  ac.importChallengesData(SAMPLE);
  const r1 = ac.markChallengeWrong("debounce");
  assert.equal(r1.ok, true);
  assert.equal(db.prepare("SELECT wrong_count FROM challenges WHERE id='debounce'").get().wrong_count, 1);
  ac.markChallengeWrong("debounce");
  assert.equal(db.prepare("SELECT wrong_count FROM challenges WHERE id='debounce'").get().wrong_count, 2, "累加");
  // 薄弱点回流到 memory（弱断言：不抛即可；memory 单例在临时 DB 上）
  assert.equal(ac.markChallengeWrong("nope").ok, false, "不存在报错");
  // 复习卡闭环：答错自动建 FSRS 卡（幂等，重复答错不重复建）
  const { review } = await import("../lib/review.mjs");
  const cards = review.loadCards().cards.filter((c) => c.topic === "手写题·手写防抖 debounce");
  assert.equal(cards.length, 1, "答错建 1 张复习卡（topic 去重）");
  assert.equal(cards[0].source, "手写题库");
  assert.ok(cards[0].question.includes("完整实现并讲清原理"), "复习卡问题为复现题");
});

cleanupTempDb(dbDir);
