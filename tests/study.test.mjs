// study.mjs 单测（无 LLM 部分）：清单 CRUD / 勾选 / 复习出题（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("study");
// generateStudyPlan 需要 outputDir 下有产出文件（CI 无真实 output/）——建临时输出目录
process.env.MIANSHI_OUTPUT_DIR = path.join(dbDir, "output");
try {
  mkdirSync(path.join(dbDir, "output", "2026-08-05_discover"), { recursive: true });
  writeFileSync(path.join(dbDir, "output", "2026-08-05_discover", "面经.md"), "# 事件循环面经\n\n".repeat(30) + "详细内容".repeat(30), "utf8");
} catch { /* ignore */ }
mockLLM(); // F1 回归测试需要 generateStudyPlan（mock 必须在 import study 之前）
const { getPlan, addPlanItems, checkItem, startReview, generateStudyPlan, syncResumeProjectItems, normalizeGroup } = await import("../lib/study.mjs");

beforeEach(async () => { await clearAllTables(); });
after(() => { cleanupTempDb(dbDir); });

// ---------- 大类归一化（group 自动归类） ----------
// 回归：frontend 知识树「浏览器原理·缓存策略」kws 含泛词"缓存"，曾把"手撕LRU缓存"（手写算法题）
// 吸进浏览器——手写/算法强信号（手撕/手写/LRU）必须先于知识树泛词命中
test("normalizeGroup：手写/算法强信号优先于知识树泛词（手撕LRU 不再进浏览器）", () => {
  assert.equal(normalizeGroup("手撕LRU缓存"), "算法与手写", "手撕 → 算法");
  assert.equal(normalizeGroup("LRU缓存"), "算法与手写", "lru → 算法");
  assert.equal(normalizeGroup("手写防抖节流"), "算法与手写", "手写 → 算法");
  assert.equal(normalizeGroup("大厂手写 Promise.all"), "算法与手写", "大厂手写 → 算法");
});

test("normalizeGroup：知识树正常命中不被破坏（HTTP 缓存仍归浏览器原理）", () => {
  // 不含手写/手撕/lru 强信号 → 走知识树，仍是浏览器原理（防过度归类）
  assert.equal(normalizeGroup("HTTP强缓存与协商缓存"), "浏览器原理");
  assert.equal(normalizeGroup("HTTP缓存"), "浏览器原理");
});

test("normalizeGroup：兜底规则 / 其他", () => {
  assert.equal(normalizeGroup("MySQL 索引回表"), "数据库", "数据库兜底");
  assert.equal(normalizeGroup("RAG 向量检索"), "RAG与LLM", "RAG 兜底");
  assert.equal(normalizeGroup("面试自我介绍模板"), "面试与求职", "面试兜底");
  assert.equal(normalizeGroup("完全不认识的主题词xyz"), "其他", "都不中 → 其他");
});

const sampleItems = [
  { topic: "事件循环与微任务", why: "高频", source: "test", verify_question: "讲一下事件循环", level: "必会" },
  { topic: "React Hooks 原理", why: "大厂爱考", source: "test", verify_question: "Hooks 为什么不能写在条件里", level: "进阶" },
];

test("addPlanItems 新增条目", () => {
  const r = addPlanItems(sampleItems);
  assert.equal(r.added, 2);
  const plan = getPlan();
  assert.equal(plan.items.length, 2);
  assert.ok(plan.date, "date 被设置");
  assert.equal(plan.items[0].topic, "事件循环与微任务");
  assert.equal(plan.items[0].level, "必会");
});

test("addPlanItems 去重（同 topic 不重复加）", () => {
  addPlanItems(sampleItems);
  const r = addPlanItems([{ topic: "事件循环与微任务", why: "x" }]);
  assert.equal(r.added, 0);
  assert.equal(getPlan().items.length, 2);
});

test("addPlanItems null/undefined topic 跳过", () => {
  // 空格/伪知识点不过滤（agent 层已先 _cleanTopic 过滤）；只跳过 falsy
  const r = addPlanItems([{ topic: null }, { topic: undefined }, { topic: "综合能力" }]);
  assert.equal(r.added, 1);
  assert.equal(getPlan().items[0].topic, "综合能力");
});

test("checkItem 勾选完成：doneAt + 自动建复习卡", async () => {
  addPlanItems(sampleItems);
  const plan = getPlan();
  const item = plan.items[0];
  const r = await checkItem(item.id, true);
  assert.equal(r.ok, true);
  assert.equal(r.item.done, true);
  assert.ok(r.item.doneAt);
  // 学习闭环：自动建 FSRS 复习卡（checkItem 内部异步 import().then 建卡——等待微任务落定）
  const { review } = await import("../lib/review.mjs");
  await new Promise((r) => setTimeout(r, 30));
  const card = review.loadCards().cards.find((c) => c.topic === item.topic);
  assert.ok(card, "勾选完成自动建复习卡");
  // 参考答案：verify_question 兜底 或 讲解存档（study_notes/{topic}.md，真实环境存在时优先——测试不假设文件系统）
  assert.ok(card.answer && card.answer.length > 0, "复习卡有参考答案");
});

test("checkItem 取消勾选", async () => {
  addPlanItems(sampleItems);
  const item = getPlan().items[0];
  await checkItem(item.id, true);
  const r = await checkItem(item.id, false);
  assert.equal(r.item.done, false);
  // 取消勾选：doneAt 清空（修复 LOW-4）+ 自动建的复习卡删除（修复 LOW-10）
  assert.equal(r.item.doneAt, null, "取消勾选清空完成时间");
  const { review } = await import("../lib/review.mjs");
  await new Promise((r) => setTimeout(r, 30));
  const card = review.loadCards().cards.find((c) => c.topic === item.topic);
  assert.equal(card, undefined, "取消勾选删除自动建的复习卡");
});

test("checkItem 不存在的 id 返回错误", async () => {
  const r = await checkItem("不存在", true);
  assert.equal(r.ok, false);
});

test("startReview 给未复盘项出验证题", async () => {
  addPlanItems(sampleItems);
  const r = await startReview();
  assert.equal(r.ok, true);
  assert.equal(r.questions.length, 2);
  assert.ok(r.questions[0].question.length > 0);
  assert.ok(r.questions[0].id);
});

test("startReview 全部复盘后返回错误", async () => {
  addPlanItems([sampleItems[0]]);
  // 直接置为已复盘（answerReview 正常路径在 study-llm.test 覆盖）
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET reviewed=1 WHERE topic=?").run("事件循环与微任务");
  const r = await startReview();
  assert.equal(r.ok, false);
});

test("getPlan 空库返回空清单", () => {
  const plan = getPlan();
  assert.deepEqual(plan.items, []);
  assert.equal(plan.date, "");
});

test("normalizeTopic/isSimilarTopic 相似去重（防表述漂移重复 + 层级降级）", async () => {
  const { normalizeTopic, isSimilarTopic } = await import("../lib/study.mjs");
  // 归一化：去括号内容/标点/词尾
  assert.equal(normalizeTopic("事件循环（浏览器环境）"), "事件循环", "去括号内容");
  // 相似判定：归一化后相等或互相包含
  assert.ok(isSimilarTopic(normalizeTopic("浏览器渲染机制与性能优化"), normalizeTopic("浏览器渲染性能优化")), "同知识点不同表述");
  assert.ok(isSimilarTopic(normalizeTopic("React Fiber 调度原理"), normalizeTopic("Fiber 调度机制")), "包含关系");
  assert.ok(isSimilarTopic(normalizeTopic("事件循环"), normalizeTopic("事件循环与微任务")), "包含关系");
  assert.ok(isSimilarTopic(normalizeTopic("防抖与节流原理"), normalizeTopic("防抖节流")), "词尾去除后相等");
  // 不误判：不同知识点
  assert.ok(!isSimilarTopic(normalizeTopic("深拷贝"), normalizeTopic("浅拷贝")), "深拷贝≠浅拷贝");
  assert.ok(!isSimilarTopic(normalizeTopic("防抖"), normalizeTopic("节流")), "防抖≠节流");
  assert.ok(!isSimilarTopic("", ""), "空串不相似");
});

// F1 回归：重新生成清单时新条目 id 不能与旧条目碰撞（旧版 `s${i+1}` 会覆盖旧行 → 抹掉完成/复盘进度）
test("addPlanItems 支持 group 分组（简历项目固定组，不再散落未分类）", () => {
  addPlanItems([{ topic: "项目·网易云音乐", why: "简历项目", source: "简历拷打", group: "简历项目", level: "必会" }]);
  const item = getPlan().items.find((i) => i.topic === "项目·网易云音乐");
  assert.equal(item.grp, "简历项目", "group 落库到 grp 字段");
});

test("syncResumeProjectItems：简历更新删除过时未完成项目、保留当前项目与已完成条目", async () => {
  // 旧简历：网易云音乐 + 低代码平台
  addPlanItems([
    { topic: "项目·网易云音乐", why: "简历项目", source: "简历拷打", group: "简历项目", level: "必会" },
    { topic: "项目·低代码平台", why: "简历项目", source: "简历拷打", group: "简历项目", level: "必会" },
    { topic: "事件循环", why: "知识点", source: "产出" }, // 非项目条目不受影响
  ]);
  // 完成"低代码平台"（保留学习记录）
  const lowcode = getPlan().items.find((i) => i.topic === "项目·低代码平台");
  await checkItem(lowcode.id, true);
  // 新简历：只保留低代码平台（网易云音乐已移除）
  const r = syncResumeProjectItems(["低代码平台"]);
  assert.equal(r.removed, 1, "删除过时未完成项目（网易云音乐）");
  const plan = getPlan();
  assert.ok(!plan.items.some((i) => i.topic === "项目·网易云音乐"), "网易云音乐条目已清除");
  assert.ok(plan.items.some((i) => i.topic === "项目·低代码平台" && i.done), "当前项目保留（已完成状态保留）");
  assert.ok(plan.items.some((i) => i.topic === "事件循环"), "非项目条目不受影响");
});

test("syncResumeProjectItems：无过时项目 → removed 0", () => {
  addPlanItems([{ topic: "项目·A", source: "简历拷打", level: "必会" }]);
  const r = syncResumeProjectItems(["A"]);
  assert.equal(r.removed, 0);
  assert.equal(getPlan().items.length, 1);
});

// F1 回归：重新生成清单时新条目 id 不能与旧条目碰撞（旧版 `s${i+1}` 会覆盖旧行 → 抹掉完成/复盘进度）
test("regenerateStudyPlan keeps old items' done/reviewed state", async () => {
  // 首次生成：2 条入库
  setLlmResponses('{"items":[{"topic":"事件循环","why":"高频","source":"a.md","verify_question":"q","level":"必会"},{"topic":"Fiber 原理","why":"区分度","source":"b.md","verify_question":"q","level":"进阶"}]}');
  const r1 = await generateStudyPlan();
  assert.equal(r1.error, undefined);
  assert.equal(r1.items.length, 2);
  // 勾选完成 + 复盘第一条（模拟用户学习进度）
  const item = getPlan().items.find((i) => i.topic === "事件循环");
  await checkItem(item.id, true);
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE study_plan_items SET reviewed=1, reviewed_at=? WHERE topic=?").run(new Date().toISOString(), "事件循环");
  // 二次生成：新条目 topic 不同（旧版会生成与旧条目同 id 的 `s1`，INSERT OR REPLACE 抹掉旧行）
  setLlmResponses('{"items":[{"topic":"防抖节流","why":"高频","source":"c.md","verify_question":"q","level":"必会"}]}');
  const r2 = await generateStudyPlan();
  assert.equal(r2.error, undefined);
  assert.equal(r2.addedCount, 1, "新条目加入");
  // 从 DB 重读（savePlan 全量重写后）——旧条目仍在且进度未丢
  const plan = getPlan();
  assert.equal(plan.items.length, 3, "旧 2 条 + 新 1 条全部保留");
  const kept = plan.items.find((i) => i.topic === "事件循环");
  assert.ok(kept, "旧条目仍在（未被新条目覆盖）");
  assert.equal(kept.done, true, "done 状态保留");
  assert.equal(kept.reviewed, true, "reviewed 状态保留");
});
