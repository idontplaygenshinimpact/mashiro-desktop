// 闭环驱动引擎单测：JD→学习 / 岗位→面试 / 短板→岗位 / 方向→学习 / 闭环建议
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, mockLLM, setLlmResponses, resetMemoryState } from "./helpers.mjs";

let tmpDir;
before(() => {
  tmpDir = setupTempDb("loop");
  mockLLM(); // 必须在 import 被测模块前
});
after(() => cleanupTempDb(tmpDir));

// ---------- 工具：技术关键词提取 ----------
test("extractTechKeywords：JD 文本提取技术栈（本地词表，无 LLM）", async () => {
  const { extractTechKeywords } = await import("../lib/loop.mjs");
  const techs = extractTechKeywords("熟悉 React、TypeScript，了解 Webpack 工程化和性能优化");
  assert.ok(techs.includes("React"));
  assert.ok(techs.includes("TypeScript"));
  assert.ok(techs.includes("Webpack"));
  assert.ok(techs.includes("性能优化"));
  assert.deepEqual(extractTechKeywords(""), []);
});

// ---------- jobs → learning：JD 反推考点 ----------
test("deriveStudyFromJob：JD → LLM 提炼考点 → 学习清单", async () => {
  const { deriveStudyFromJob } = await import("../lib/loop.mjs");
  setLlmResponses('{"points":[{"topic":"React Hooks 闭包陷阱","why":"JD 要求熟悉 React"},{"topic":"虚拟DOM diff 算法","why":"JD 要求性能优化"}]}');
  const r = await deriveStudyFromJob({ company: "字节跳动", title: "前端开发工程师", jdText: "熟悉 React，有性能优化经验" });
  assert.equal(r.ok, true);
  assert.equal(r.added, 2, "两个考点入库");
  assert.deepEqual(r.points, ["React Hooks 闭包陷阱", "虚拟DOM diff 算法"]);
  // 校验已进清单
  const { getPlan } = await import("../lib/study.mjs");
  const plan = getPlan();
  assert.ok(plan.items.some((i) => i.topic === "React Hooks 闭包陷阱" && i.source?.includes("字节跳动")), "清单含目标岗位来源");
});

test("deriveStudyFromJob：无 JD / LLM 空响应 → error 不抛", async () => {
  const { deriveStudyFromJob } = await import("../lib/loop.mjs");
  const r1 = await deriveStudyFromJob({ company: "X", title: "Y", jdText: "" });
  assert.equal(r1.ok, false);
  assert.ok(r1.error.includes("JD"), "提示先抓 JD");
  setLlmResponses(""); // 空响应
  const r2 = await deriveStudyFromJob({ company: "X", title: "Y", jdText: "有 JD 内容" });
  assert.equal(r2.ok, false);
});

// ---------- jobs → interview：按岗面试 ----------
test("startInterviewForJob：按岗位 JD 出题（focus 含技术栈），面试会话启动", async () => {
  const { startInterviewForJob } = await import("../lib/loop.mjs");
  const { addJob } = await import("../lib/jobs.mjs");
  const created = addJob({ company: "测试公司", title: "前端工程师（校招）", job_type: "校招", direction: "frontend", apply_url: "https://x/job/1.html" });
  // 补 JD 详情（直接 UPDATE jd_text）
  const { db } = await import("../lib/db.mjs");
  db.prepare("UPDATE job_posts SET jd_text=? WHERE id=?").run("负责 React 应用开发，熟悉 TypeScript、性能优化", String(created.id));
  setLlmResponses(
    '{"question":"请讲讲 React Hooks 的工作原理","dimension":"React 原理","basis":"岗位JD","criteria":"讲清闭包与依赖","boundary":"边界"}',
    "回答不错，下一问。"
  );
  const r = await startInterviewForJob(created.id);
  assert.equal(r.ok, true);
  assert.equal(r.job.company, "测试公司");
  assert.ok(r.question.includes("React"), "问题与岗位技术栈相关");
  // 面试会话已建立（memory.interview）
  const { memory } = await import("../lib/memory.mjs");
  assert.ok(memory.getInterview(), "面试会话已启动");
});

test("startInterviewForJob：岗位不存在 → error", async () => {
  const { startInterviewForJob } = await import("../lib/loop.mjs");
  const r = await startInterviewForJob("no-such-id");
  assert.equal(r.ok, false);
});

// ---------- learning → jobs：短板感知岗位建议 ----------
test("suggestJobsForWeakPoints：短板命中 JD → needStudy；未命中 → canApply", async () => {
  const { suggestJobsForWeakPoints } = await import("../lib/loop.mjs");
  const { addJob } = await import("../lib/jobs.mjs");
  const { db } = await import("../lib/db.mjs");
  const { memory } = await import("../lib/memory.mjs");
  resetMemoryState(memory);
  // 两个岗位：一个 JD 提到 TypeScript（短板），一个不提
  const j1 = addJob({ company: "A公司", title: "TS 工程师", job_type: "校招", direction: "frontend", apply_url: "https://x/j1.html" });
  addJob({ company: "B公司", title: "通用前端", job_type: "校招", direction: "frontend", apply_url: "https://x/j2.html" });
  db.prepare("UPDATE job_posts SET jd_text=? WHERE id=?").run("要求 TypeScript 熟练", String(j1.id));
  // 制造薄弱点
  memory.addWeakPoint("TypeScript", "复盘", "agent");
  const r = suggestJobsForWeakPoints();
  assert.equal(r.ok, true);
  assert.ok(r.weak.includes("TypeScript"), "短板列出");
  assert.ok(r.needStudy.some((x) => x.company === "A公司"), "涉及 TypeScript 的岗位进 needStudy");
  assert.ok(r.canApply.some((x) => x.company === "B公司"), "不涉及短板的岗位进 canApply");
  resetMemoryState(memory);
});

// ---------- 全节点 → 闭环建议 ----------
test("loopSuggest：规则引擎给出下一步（无薄弱点时建议驱动）", async () => {
  const { loopSuggest } = await import("../lib/loop.mjs");
  const { memory } = await import("../lib/memory.mjs");
  resetMemoryState(memory);
  const s = loopSuggest();
  assert.equal(s.ok, true);
  assert.ok(s.nodes, "四节点状态存在");
  assert.ok(Array.isArray(s.suggestions) && s.suggestions.length > 0, "有建议");
  assert.ok(s.suggestions.some((x) => x.includes("方向") || x.includes("闭环") || x.includes("岗位") || x.includes("学习")), "建议与闭环相关");
});

// ---------- 投递备战记录 ----------
test("recordAppliedCompany/getAppliedCompanies：去重置顶 + 最近 10 家", async () => {
  const { recordAppliedCompany, getAppliedCompanies } = await import("../lib/loop.mjs");
  const r1 = recordAppliedCompany("字节跳动");
  assert.equal(r1.ok, true);
  recordAppliedCompany("拼多多");
  recordAppliedCompany("字节跳动"); // 重复 → 更新时间为最新
  const list = getAppliedCompanies();
  assert.equal(list.length, 2);
  assert.equal(list[0].company, "字节跳动", "最近投递的置顶");
  assert.equal(recordAppliedCompany("").ok, false, "空公司拒绝");
});

// ---------- 专注目标推荐 ----------
test("suggestFocusGoal：到期复习卡/薄弱点/清单未完成 → top N", async () => {
  const { suggestFocusGoal } = await import("../lib/loop.mjs");
  const { memory } = await import("../lib/memory.mjs");
  const { review } = await import("../lib/review.mjs");
  const { db } = await import("../lib/db.mjs");
  resetMemoryState(memory);
  // 制造：薄弱点 + 到期复习卡 + 清单未完成
  memory.addWeakPoint("TypeScript 类型体操", "复盘", "agent");
  review.addCard({ topic: "事件循环", question: "讲事件循环", source: "薄弱点" });
  db.prepare("UPDATE review_cards SET created_at = ?").run(Date.now() - 2 * 24 * 3600 * 1000); // 卡创建 2 天前 → 到期
  const goals = suggestFocusGoal(3);
  assert.ok(goals.length >= 1, "有推荐目标");
  assert.ok(goals.some((g) => g.topic === "事件循环"), "到期复习卡进入推荐");
  assert.ok(goals.some((g) => g.topic === "TypeScript 类型体操"), "薄弱点进入推荐");
  resetMemoryState(memory);
});

test("suggestFocusGoal：同 topic 跨源去重 + 薄弱点按 failCount 排序（修复：推荐永远不变）", async () => {
  const { suggestFocusGoal } = await import("../lib/loop.mjs");
  const { memory } = await import("../lib/memory.mjs");
  const { review } = await import("../lib/review.mjs");
  const { db } = await import("../lib/db.mjs");
  resetMemoryState(memory);
  // 同一 topic 同时是复习卡 + 薄弱点 → 只出现一次（复习优先）
  memory.addWeakPoint("去重主题", "复盘", "agent");
  review.addCard({ topic: "去重主题", question: "q", source: "薄弱点" });
  db.prepare("UPDATE review_cards SET created_at = ?").run(Date.now() - 2 * 24 * 3600 * 1000);
  // failCount 高的薄弱点必须排在前面（此前依赖内存插入序，可能截断丢最弱的）
  memory.addWeakPoint("弱项A", "模拟面试", "agent");
  memory.addWeakPoint("弱项A", "模拟面试", "agent");
  memory.addWeakPoint("弱项B", "模拟面试", "agent");
  const goals = suggestFocusGoal(6);
  const topics = goals.map((g) => g.topic);
  assert.equal(topics.filter((t) => t === "去重主题").length, 1, "同 topic 跨源去重");
  assert.ok(topics.indexOf("弱项A") < topics.indexOf("弱项B"), "failCount 高的弱项排前面");
  resetMemoryState(memory);
});

test("getDueCards：到期卡按到期时间排序（复习掉一张下一张顶上，推荐会轮换）", async () => {
  const { review } = await import("../lib/review.mjs");
  const { db } = await import("../lib/db.mjs");
  // 两张新卡：一张 10 天前创建、一张 2 天前创建 → 都到期，老的先
  review.addCard({ topic: "老卡", question: "q1", source: "测试" });
  review.addCard({ topic: "新卡", question: "q2", source: "测试" });
  db.prepare("UPDATE review_cards SET created_at = ? WHERE topic = ?").run(Date.now() - 10 * 24 * 3600 * 1000, "老卡");
  db.prepare("UPDATE review_cards SET created_at = ? WHERE topic = ?").run(Date.now() - 2 * 24 * 3600 * 1000, "新卡");
  const due = review.getDueCards();
  const idxOld = due.findIndex((c) => c.topic === "老卡");
  const idxNew = due.findIndex((c) => c.topic === "新卡");
  assert.ok(idxOld >= 0 && idxNew >= 0, "两张都到期");
  assert.ok(idxOld < idxNew, "更早创建（更久没复习）的卡排前面");
});

// ---------- 建议引擎消费数据（复习到期/专注/刷题/备战/日程） ----------
test("loopSuggest：复习到期/刷题/专注状态进入建议", async () => {
  const { loopSuggest } = await import("../lib/loop.mjs");
  const { memory } = await import("../lib/memory.mjs");
  const { review } = await import("../lib/review.mjs");
  const { markOjDone } = await import("../lib/oj.mjs");
  const { db } = await import("../lib/db.mjs");
  resetMemoryState(memory);
  // 到期复习卡
  review.addCard({ topic: "闭包", question: "闭包原理", source: "测试" });
  db.prepare("UPDATE review_cards SET created_at = ?").run(Date.now() - 2 * 24 * 3600 * 1000);
  // 刷题记录
  markOjDone({ bm_no: "BM1", title: "反转链表", category: "链表" });
  const s = loopSuggest();
  assert.ok(s.nodes.learning.reviewDue >= 1, "复习到期数进入节点状态");
  assert.ok(s.nodes.oj.done >= 1, "刷题数进入节点状态");
  assert.ok(s.suggestions.some((x) => x.includes("复习卡到期")), "复习建议生成");
  resetMemoryState(memory);
});
