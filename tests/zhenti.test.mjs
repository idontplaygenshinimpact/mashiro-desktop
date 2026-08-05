// zhenti 真题搜集测试：双轨过滤（大厂技术真题 + 平台模拟卷）/ 入库去重 / 清单查询
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockFetchPage, setMockPages } from "./helpers.mjs";

const dbDir = setupTempDb("zhenti");
mockFetchPage();
const zhenti = await import("../lib/zhenti.mjs");

const EXAMS = [
  { text: "2025年春招-阿里巴巴-研发岗-第一批笔试", href: "https://www.nowcoder.com/exam/test/62105698/summary" },
  { text: "2026届-华为-07月04号开发岗", href: "https://www.nowcoder.com/exam/test/68309503/summary" },
  { text: "2025年秋招-美团-技术岗-第一批笔试", href: "https://www.nowcoder.com/exam/test/63140272/summary" },
  { text: "中国银行2025春招笔试-模拟卷", href: "https://www.nowcoder.com/exam/test/59813724/summary" },
  { text: "中国移动2025春招笔试-模拟卷", href: "https://www.nowcoder.com/exam/test/59814106/summary" },
  { text: "2025春招-美团-综合能力测试-产品&运营笔试", href: "https://www.nowcoder.com/exam/test/61979867/summary" }, // 非技术应排除
  { text: "某小公司2025校招笔试", href: "https://www.nowcoder.com/exam/test/77777777/summary" }, // 非大厂非模拟排除
];

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

test("collectZhentiList 双轨收录：大厂技术真题 + 模拟卷；排除非技术/非目标", async () => {
  setMockPages([{ text: "mock", links: [...EXAMS, { text: "无关链接", href: "https://x.com/other" }] }]);
  const r = await zhenti.collectZhentiList();
  assert.equal(r.added, 5, "入库 5：阿里/华为/美团真题 + 银行/移动模拟卷");
  const list = zhenti.getZhentiList();
  assert.equal(list.length, 5);
  const real = list.filter((p) => p.kind === "real");
  const simulate = list.filter((p) => p.kind === "simulate");
  assert.equal(real.length, 3, "3 套大厂真题");
  assert.equal(simulate.length, 2, "2 套模拟卷");
  assert.ok(real.some((p) => p.title.includes("阿里巴巴")), "阿里真题");
  assert.ok(!list.some((p) => p.title.includes("产品&运营")), "非技术岗排除");
  assert.ok(!list.some((p) => p.title.includes("某小公司")), "非目标公司排除");
});

test("collectZhentiList 去重（testId 相同不重复入库）", async () => {
  setMockPages([{ text: "mock", links: EXAMS.slice(0, 3) }]);
  const r1 = await zhenti.collectZhentiList();
  setMockPages([{ text: "mock", links: EXAMS.slice(0, 3) }]); // 第二次同数据
  const r2 = await zhenti.collectZhentiList();
  assert.equal(r1.added, 3);
  assert.equal(r2.added, 0, "重复搜集不新增");
  assert.equal(r2.dup, 3, "计为去重");
  assert.equal(zhenti.getZhentiList().length, 3);
});

test("getZhentiStats 按 kind 统计", async () => {
  setMockPages([{ text: "mock", links: EXAMS }]);
  await zhenti.collectZhentiList();
  const s = zhenti.getZhentiStats();
  assert.equal(s.total, 5);
  assert.equal(s.byKind.find((k) => k.kind === "real").n, 3);
  assert.equal(s.byKind.find((k) => k.kind === "simulate").n, 2);
  assert.ok(s.byCompany.some((c) => c.company === "华为"), "按公司统计");
});

test("collectZhentiDetails 解析题型分布并回填", async () => {
  setMockPages([{ text: "mock", links: EXAMS.slice(0, 1) }]);
  await zhenti.collectZhentiList();
  setMockPages([
    { text: "2025年春招-阿里巴巴-研发岗-第一批笔试\n匹配职位 | Java工程师、前端工程师\n题型数量 | 总题量 18 | 单选题 9 | 多选题 6 | 编程题 3" },
  ]);
  const r = await zhenti.collectZhentiDetails(5);
  assert.equal(r.length, 1);
  assert.equal(r[0].question, 18);
  assert.equal(r[0].single, 9);
  assert.equal(r[0].program, 3);
  assert.ok(r[0].jobTags.includes("前端工程师"), "职位标签");
  const list = zhenti.getZhentiList();
  assert.equal(list[0].questionCount, 18, "详情回填 DB");
});

test("addWrongQuestion 错题 → 学习清单（必会）+ FSRS 复习卡", async () => {
  const { db } = await import("../lib/db.mjs");
  const r = await zhenti.addWrongQuestion({ paperId: "62105698", company: "阿里", paperTitle: "2025年春招-阿里巴巴-研发岗-第一批笔试", question: "React 的 setState 是同步还是异步？", answer: "答错：说成同步" });
  assert.equal(r.ok, true);
  assert.ok(r.topic.includes("阿里"), "topic 带公司");
  const plan = db.prepare("SELECT * FROM study_plan_items WHERE source='牛客真题'").all();
  assert.equal(plan.length, 1, "入学习清单");
  assert.equal(plan[0].level, "必会");
  assert.ok(String(plan[0].verify_question).includes("setState"), "验证题=题干");
  const card = db.prepare("SELECT * FROM review_cards WHERE source='牛客真题'").all();
  assert.equal(card.length, 1, "入复习卡");
  assert.ok(String(card[0].answer).includes("答错"), "记录错误答案");
});

test("saveNowcoderCookie 解析保存 + getNowcoderCookie 读回；非法格式拒绝", () => {
  const bad = zhenti.saveNowcoderCookie("not-a-cookie");
  assert.equal(bad.ok, false);
  const r = zhenti.saveNowcoderCookie("NOWCODER_UID=12345; NOWCODER_TOKEN=abc; domain=.nowcoder.com");
  assert.equal(r.ok, true);
  assert.equal(r.count, 3, "解析 3 个字段");
  const pairs = zhenti.getNowcoderCookie();
  assert.equal(pairs.length, 3);
  assert.equal(pairs[0].name, "NOWCODER_UID");
});

test("addPaperToPlan 整套真题 → 学习清单（练习入口条目）", async () => {
  setMockPages([{ text: "mock", links: EXAMS.slice(0, 2) }]);
  await zhenti.collectZhentiList();
  const r = await zhenti.addPaperToPlan("62105698");
  assert.equal(r.ok, true);
  assert.ok(r.topic.includes("阿里"), "topic 带公司");
  const { db } = await import("../lib/db.mjs");
  const plan = db.prepare("SELECT * FROM study_plan_items WHERE source='牛客真题'").all();
  assert.equal(plan.length, 1, "入学习清单");
  assert.equal(plan[0].level, "必会");
  assert.ok(String(plan[0].verify_question).includes("nowcoder.com"), "验证题含练习链接");
  // 重复加入去重（study addPlanItems 按 topic 去重）
  const r2 = await zhenti.addPaperToPlan("62105698");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM study_plan_items WHERE source='牛客真题'").get().n, 1, "重复不新增");
  // 不存在的试卷
  const r3 = await zhenti.addPaperToPlan("99999999");
  assert.equal(r3.ok, false);
});
