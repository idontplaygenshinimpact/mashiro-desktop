// study.mjs 单测（LLM 依赖部分）：generateStudyPlan / answerReview
// mock llm.mjs 返回 OpenAI 协议对象——若代码对对象直接 .replace() 会在此暴露（回归防线）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses, getReplyText, getLastMessages } from "./helpers.mjs";

const dbDir = setupTempDb("study-llm");
// generateStudyPlan 需要 outputDir 下有产出文件（CI 无真实 output/）——建临时输出目录并放一个产出 md
process.env.MIANSHI_OUTPUT_DIR = path.join(dbDir, "output");
try {
  mkdirSync(path.join(dbDir, "output", "2026-08-05_discover"), { recursive: true });
  writeFileSync(path.join(dbDir, "output", "2026-08-05_discover", "面经.md"), "# 事件循环面经\n\n".repeat(30) + "详细内容".repeat(30), "utf8");
} catch { /* ignore */ }
mockLLM(); // 必须在 import study 之前
const { generateStudyPlan, getPlan, addPlanItems, answerReview } = await import("../lib/study.mjs");
const { memory } = await import("../lib/memory.mjs");

beforeEach(async () => {
  await clearAllTables();
  for (const t of (memory.getWeakPoints() || []).map((w) => w.topic)) memory.clearWeakPoint(t);
});
after(() => { cleanupTempDb(dbDir); });

test("generateStudyPlan：LLM 返回代码块 JSON → 生成清单入库", async () => {
  setLlmResponses('```json\n{"items":[{"topic":"事件循环","why":"高频考点","source":"a.md","verify_question":"讲一下事件循环","level":"必会"},{"topic":"Fiber 原理","why":"大厂区分度","source":"b.md","verify_question":"Fiber 是什么","level":"进阶"}]}\n```');
  const r = await generateStudyPlan();
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].topic, "事件循环");
  assert.equal(r.items[0].level, "必会");
  // LLM 未返回 group → 按知识树分类归一化（事件循环→JavaScript 核心、Fiber→React）
  assert.equal(r.items[0].grp, "JavaScript 核心");
  assert.equal(r.items[1].grp, "React");
  // 已入库
  assert.equal(getPlan().items.length, 2);
});

test("generateStudyPlan：LLM 返回 group → grp 归一化为知识树分类，同组可多条", async () => {
  setLlmResponses('{"items":[{"topic":"RAG 混合检索策略","why":"高频","source":"a.md","verify_question":"q","level":"必会","group":"RAG 与 LLM"},{"topic":"向量数据库选型","why":"大厂","source":"a.md","verify_question":"q","level":"进阶","group":"RAG 与 LLM"},{"topic":"宏任务与微任务执行顺序","why":"高频","source":"b.md","verify_question":"q","level":"必会","group":"事件循环与异步"}]}');
  const r = await generateStudyPlan();
  assert.equal(r.error, undefined);
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].grp, "RAG与LLM"); // 知识树外领域 → 兜底大类
  assert.equal(r.items[1].grp, "RAG与LLM", "同一大类多条子知识点用同一 group 名");
  assert.equal(r.items[2].grp, "JavaScript 核心"); // 宏任务/微任务 → 知识树 JavaScript 核心
  // 入库一致
  const plan = getPlan();
  assert.equal(plan.items.find((i) => i.topic === "向量数据库选型").grp, "RAG与LLM");
  // 旧条目（addPlanItems 无 group）grp 为空不受影响
  const old = plan.items.find((i) => i.topic === "事件循环");
  assert.equal(old, undefined, "旧清单为空，无残留干扰");
});

test("generateStudyPlan：LLM 返回非法内容 → 不崩溃，返回 note（非 error）", async () => {
  setLlmResponses("这不是 JSON");
  const r = await generateStudyPlan();
  assert.equal(r.error, undefined, "非法内容不再报 error（自动重试后仍失败 → 空结果 note）");
  assert.equal(r.addedCount, 0);
  assert.ok(r.note, "带说明 note");
});

test("generateStudyPlan：返回空 items → note 提示无新知识点（非报错）", async () => {
  setLlmResponses('{"items":[]}');
  const r = await generateStudyPlan();
  assert.equal(r.error, undefined);
  assert.equal(r.addedCount, 0);
  assert.ok(r.note.includes("未提炼"), "提示未提炼到新知识点");
});

test("generateStudyPlan：level 非法值回退必会", async () => {
  setLlmResponses('{"items":[{"topic":"A","why":"w","source":"s","verify_question":"q","level":"乱写的"}]}');
  const r = await generateStudyPlan();
  assert.equal(r.items[0].level, "必会");
});

test("generateStudyPlan：不覆盖旧清单（全部保留/新条目去重）", async () => {
  // 旧清单：1 条面试实录未完成 + 1 条已完成
  addPlanItems([
    { topic: "事件循环", why: "面试被问住", source: "面试实录", verify_question: "q", level: "必会" },
    { topic: "旧知识点", why: "w", source: "s", verify_question: "q", level: "必会" },
  ]);
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET done=1, done_at=? WHERE topic='旧知识点'").run(new Date().toISOString());
  // 新生成：1 条与旧重复 + 2 条全新
  setLlmResponses('{"items":[{"topic":"事件循环","why":"重复","source":"a","verify_question":"q","level":"必会"},{"topic":"新知识点1","why":"w","source":"a","verify_question":"q","level":"进阶"},{"topic":"新知识点2","why":"w","source":"b","verify_question":"q","level":"拓展"}]}');
  const r = await generateStudyPlan();
  const topics = r.items.map((i) => i.topic);
  assert.ok(topics.includes("事件循环"), "旧未完成（面试实录）保留");
  assert.ok(topics.includes("旧知识点"), "已完成条目也保留（学习记录不被删除）");
  assert.ok(topics.includes("新知识点1") && topics.includes("新知识点2"), "新条目加入");
  assert.equal(topics.filter((t) => t === "事件循环").length, 1, "重复 topic 只留一条");
  // 入库一致
  assert.equal(getPlan().items.length, 4);
});

test("generateStudyPlan：旧条目状态字段保留", async () => {
  addPlanItems([{ topic: "闭包", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  // 旧条目先复习过
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET reviewed=1 WHERE topic='闭包'").run();
  setLlmResponses('{"items":[{"topic":"新知识点","why":"w","source":"a","verify_question":"q","level":"必会","group":"算法与手写"}]}');
  const r = await generateStudyPlan();
  const old = r.items.find((i) => i.topic === "闭包");
  assert.equal(old.reviewed, true, "旧条目复习状态保留");
  // 分类修复：addPlanItems 现自动归类（无显式 group → 知识树/规则）——旧条目不落空组，
  // 且不被新条目 group 覆盖（保持自己的归类）
  assert.ok(old.grp, "旧条目自动归类（此前 grp 全空、分类失效）");
  assert.notEqual(old.grp, "算法与手写", "旧条目 grp 不被新条目 group 覆盖");
  assert.equal(r.items.find((i) => i.topic === "新知识点").grp, "算法与手写", "新条目按 LLM group 入库");
});

test("generateStudyPlan：产出内容真实注入（非 [object Object]）+ study_notes/chat_solutions 不计入产出", async () => {
  // AI 讲解存档与对话回答目录——不应被 collect 当作爬取产出（避免自产内容循环提炼）
  mkdirSync(path.join(dbDir, "output", "study_notes"), { recursive: true });
  mkdirSync(path.join(dbDir, "output", "chat_solutions"), { recursive: true });
  writeFileSync(path.join(dbDir, "output", "study_notes", "自产讲解.md"), "# 自产讲解\n" + "这是AI自己生成的讲解内容不应进入提炼循环。".repeat(10), "utf8");
  writeFileSync(path.join(dbDir, "output", "chat_solutions", "对话回答.md"), "# 对话回答\n" + "这是对话回答内容不应进入提炼循环。".repeat(10), "utf8");
  setLlmResponses('{"items":[]}');
  await generateStudyPlan();
  const joined = getLastMessages().map((m) => String(m.content || "")).join("\n");
  assert.ok(!joined.includes("[object Object]"), "产出内容真实注入（不出现 [object Object]）");
  assert.ok(joined.includes("事件循环面经"), "产出内容在 prompt 中");
  assert.ok(joined.includes("<untrusted_data>"), "产出被不可信包裹");
  assert.ok(!joined.includes("自产讲解"), "study_notes 讲解不计入产出");
  assert.ok(!joined.includes("对话回答"), "chat_solutions 回答不计入产出");
});

test("answerReview：判分 + 回流薄弱点 + 标记已复盘", async () => {
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"事件循环","verdict":"错","comment":"讲得浅","reference":"要点1"}]}');
  const r = await answerReview([{ id: item.id, answer: "我的回答" }]);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].verdict, "错");
  // 薄弱点回流
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "事件循环"), "错题进入薄弱点");
  // 标记已复盘
  assert.equal(getPlan().items[0].reviewed, true);
});

test("answerReview：答对 → 已掌握", async () => {
  addPlanItems([{ topic: "闭包", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"闭包","verdict":"对","comment":"好","reference":"要点"}]}');
  await answerReview([{ id: item.id, answer: "回答" }]);
  assert.ok(memory.getMastered().some((m) => m.topic === "闭包"));
});

test("answerReview：答错自动建复习卡（question=verify_question）", async () => {
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "讲一下事件循环", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"事件循环","verdict":"错","comment":"浅","reference":"要点A"}]}');
  await answerReview([{ id: item.id, answer: "我的回答" }]);
  const { review } = await import("../lib/review.mjs");
  const cards = review.loadCards().cards.filter((c) => c.topic === "事件循环");
  assert.equal(cards.length, 1, "答错建复习卡（同 topic 合并为一张）");
  assert.equal(cards[0].question, "讲一下事件循环", "复习卡 question 用 verify_question");
  assert.equal(cards[0].answer, "要点A", "复习卡 answer 用参考答案");
});

test("answerReview：部分对也建复习卡", async () => {
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "讲一下事件循环", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"事件循环","verdict":"部分对","comment":"缺核心","reference":"要点B"}]}');
  await answerReview([{ id: item.id, answer: "我的回答" }]);
  const { review } = await import("../lib/review.mjs");
  const card = review.loadCards().cards.find((c) => c.topic === "事件循环");
  assert.ok(card, "部分对自动建复习卡");
  assert.equal(card.question, "讲一下事件循环");
});

test("answerReview：无答案 → 错误", async () => {
  const r = await answerReview([]);
  assert.equal(r.ok, false);
});

test("answerReview：LLM 返回非法 JSON → 空结果不崩溃", async () => {
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses("完全不是 JSON");
  const r = await answerReview([{ id: item.id, answer: "回答" }]);
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 0);
});

// 回归防线：getReplyText 是真实实现，若被测代码忘了用它（直接对响应对象操作）会抛错
test("回归：mock 响应是对象形态（与真实 llmChat 契约一致）", () => {
  const data = { choices: [{ message: { content: '{"x":1}' } }] };
  assert.equal(getReplyText(data), '{"x":1}');
  // 对象上调用 replace 必然抛 TypeError——上次 bug（study.mjs 对 llmChat 返回值 .replace）的形态
  assert.throws(() => data.replace(/x/g, ""), TypeError, "忘了 getReplyText 会炸");
});
