// quiz.mjs 单测：复习选择题（懒生成/校验/抽题洗牌/判分记录）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("quiz");
mockLLM();
const { generateQuiz, ensureQuiz, drawQuiz, submitQuiz, getQuizStats } = await import("../lib/quiz.mjs");
const { review } = await import("../lib/review.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

const VALID_JSON = JSON.stringify({
  questions: [
    { question: "事件循环中微任务何时执行？", options: ["宏任务后", "当前宏任务末尾", "下一轮", "立即"], answer: 1, explain: "微任务在宏任务结束后执行" },
    { question: "setTimeout 属于？", options: ["微任务", "宏任务", "同步", "渲染"], answer: 1, explain: "setTimeout 是宏任务" },
    { question: "Promise.then 属于？", options: ["宏任务", "微任务", "同步", "I/O"], answer: 1, explain: "then 回调是微任务" },
    { question: "执行顺序？", options: ["同步>微>宏", "宏>微>同步", "随机", "并行"], answer: 0, explain: "先同步再微任务再宏任务" },
    { question: "requestAnimationFrame？", options: ["宏任务", "渲染前回调", "微任务", "同步"], answer: 1, explain: "rAF 在渲染前执行" },
    { question: "微任务队列何时清空？", options: ["永不", "宏任务后", "每帧", "随机"], answer: 1, explain: "当前宏任务结束后清空" },
  ],
});

test("generateQuiz：合法 JSON 批量入库（batch=1）", async () => {
  const card = review.addCard({ topic: "事件循环", question: "讲事件循环", answer: "宏微任务顺序" });
  setLlmResponses(VALID_JSON);
  const r = await generateQuiz(card);
  assert.equal(r.ok, true);
  assert.equal(r.added, 6);
  const rows = db.prepare("SELECT * FROM quiz_questions WHERE card_id = ?").all(card.id);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].batch, 1);
  assert.ok(JSON.parse(rows[0].options).length >= 2);
});

test("generateQuiz：烂题过滤（选项重复/答案越界/空解析 → 丢弃）", async () => {
  const card = review.addCard({ topic: "闭包", question: "q" });
  setLlmResponses(JSON.stringify({
    questions: [
      { question: "好题", options: ["A", "B", "C", "D"], answer: 0, explain: "ok" },
      { question: "选项不足", options: ["A"], answer: 0, explain: "x" },
      { question: "答案越界", options: ["A", "B"], answer: 5, explain: "x" },
      { question: "无解析", options: ["A", "B", "C", "D"], answer: 0, explain: "" },
      { question: "选项重复", options: ["A", "A", "A", "B"], answer: 0, explain: "x" },
    ],
  }));
  const r = await generateQuiz(card);
  assert.equal(r.ok, true);
  assert.equal(r.added, 1, "只有 1 题通过校验");
});

test("generateQuiz：LLM 返回乱码 → ok:false（前端降级纯文本卡）", async () => {
  const card = review.addCard({ topic: "原型链", question: "q" });
  setLlmResponses("乱码");
  const r = await generateQuiz(card);
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM quiz_questions").get().n, 0, "不落任何脏题");
});

test("ensureQuiz：空题库懒生成，有题库直接复用", async () => {
  const card = review.addCard({ topic: "防抖节流", question: "q" });
  setLlmResponses(VALID_JSON);
  const r1 = await ensureQuiz(card.id);
  assert.equal(r1.ok, true);
  assert.equal(r1.fromCache, false);
  // 第二次：复用缓存
  const r2 = await ensureQuiz(card.id);
  assert.equal(r2.fromCache, true);
  assert.equal(r2.total, 6);
});

test("drawQuiz：随机抽 3 题 + 选项洗牌（集合不变、正确项在选项中）", () => {
  const card = review.addCard({ topic: "事件循环", question: "q" });
  for (let i = 0; i < 5; i++) {
    db.prepare("INSERT INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`t${i}`, card.id, 1, `题${i}`, JSON.stringify(["选项A", "选项B", "选项C", "选项D"]), 2, `解析${i}`, Date.now());
  }
  const d = drawQuiz(card.id, 3);
  assert.equal(d.ok, true);
  assert.equal(d.questions.length, 3, "抽 3 题");
  assert.equal(d.total, 5);
  for (const q of d.questions) {
    assert.equal(q.options.length, 4, "4 个选项");
    assert.deepEqual([...q.options].sort(), ["选项A", "选项B", "选项C", "选项D"].sort(), "选项集合不变（仅顺序洗牌）");
    assert.ok(q.answer >= 0 && q.answer < 4, "正确项位置合法");
  }
  // 无题库返回空不崩溃
  const empty = drawQuiz("no-such-card");
  assert.equal(empty.questions.length, 0);
});

test("submitQuiz：判分 + 记录 quiz_attempts + 正确率统计", () => {
  const card = review.addCard({ topic: "事件循环", question: "q" });
  // 手工插入 2 题
  db.prepare("INSERT INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("q1", card.id, 1, "题1", JSON.stringify(["A", "B", "C", "D"]), 2, "解析1", Date.now());
  db.prepare("INSERT INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("q2", card.id, 1, "题2", JSON.stringify(["A", "B", "C", "D"]), 0, "解析2", Date.now());
  const r = submitQuiz(card.id, [
    { questionId: "q1", chosen: 2 }, // 对
    { questionId: "q2", chosen: 1 }, // 错
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.correct, 1);
  assert.equal(r.total, 2);
  assert.equal(r.results[0].correct, true);
  assert.equal(r.results[0].rightIndex, 2);
  assert.equal(r.results[1].correct, false);
  assert.equal(r.results[1].explain, "解析2");
  const stats = getQuizStats(card.id);
  assert.equal(stats.total, 2);
  assert.equal(stats.correct, 1);
  assert.equal(stats.wrong, 1);
  assert.equal(stats.wrongQuestions, 1);
});

test("submitQuiz：换批后抽题优先新批", () => {
  const card = review.addCard({ topic: "HTTP", question: "q" });
  db.prepare("INSERT INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("old1", card.id, 1, "旧题1", JSON.stringify(["A", "B"]), 0, "x", Date.now());
  db.prepare("INSERT INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("old2", card.id, 1, "旧题2", JSON.stringify(["A", "B"]), 0, "x", Date.now());
  db.prepare("INSERT INTO quiz_questions (id, card_id, batch, question, options, answer, explain, created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("new1", card.id, 2, "新题1", JSON.stringify(["A", "B"]), 0, "x", Date.now());
  const d = drawQuiz(card.id, 3);
  assert.equal(d.questions.length, 3);
  assert.equal(d.questions[0].id, "new1", "新批优先");
});

// ---------- 方向画像驱动：改画像后选择题 prompt 跟随（转后端出后端题） ----------
test("generateQuiz prompt 跟随方向画像（角色/范围/代码语言）", async () => {
  const { saveCareerProfile, resetCareerProfile, invalidateCareerProfile } = await import("../lib/career.mjs");
  const { getLastMessages, setLlmResponses } = await import("./helpers.mjs");
  const card = review.addCard({ topic: "数据库索引", question: "讲讲 B+树" });
  try {
    saveCareerProfile({
      roleLabel: "资深后端开发面试辅导老师",
      scopeNote: "后端 / 微服务 / 数据库",
      codeLang: "Python / Go",
    });
    setLlmResponses(VALID_JSON);
    await generateQuiz(card);
    const promptText = getLastMessages().map((m) => m.content).join("\n");
    assert.ok(promptText.includes("资深后端开发面试辅导老师"), "角色跟随画像");
    assert.ok(promptText.includes("后端 / 微服务 / 数据库"), "方向范围跟随画像");
    assert.ok(promptText.includes("Python / Go"), "代码语言跟随画像");
    assert.ok(!promptText.includes("资深前端面试辅导老师"), "不再硬编码前端角色");
  } finally {
    resetCareerProfile();
    invalidateCareerProfile();
  }
});
