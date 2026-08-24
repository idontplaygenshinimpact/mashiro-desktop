// interview.mjs 单测：模拟面试全流程（mock LLM + 临时 DB）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("interview");
mockLLM();
const { startInterview, submitAnswer, endInterview } = await import("../lib/interview.mjs");
const { memory } = await import("../lib/memory.mjs");
const { review } = await import("../lib/review.mjs");

beforeEach(async () => {
  await clearAllTables();
  memory.clearInterview();
  for (const t of (memory.getWeakPoints() || []).map((w) => w.topic)) memory.clearWeakPoint(t);
});
after(() => { cleanupTempDb(dbDir); });

const FIRST_Q = '{"question":"讲讲事件循环和微任务","basis":"面经高频","dimension":"原理","criteria":"宏微任务、顺序、场景","boundary":"不涉及浏览器渲染"}';

test("startInterview 正常开启面试", async () => {
  setLlmResponses(FIRST_Q);
  const r = await startInterview({ position: "前端" });
  assert.equal(r.ok, true);
  assert.ok(r.question.includes("事件循环"));
  assert.equal(r.round, 1);
  assert.ok(memory.getInterview(), "会话已建立");
  assert.equal(memory.getInterview().position, "前端");
});

test("startInterview 已有面试进行中 → error", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const r = await startInterview({ position: "前端" });
  assert.ok(r.error, "应返回错误");
});

// 回归护栏：配置了简历项目源码（personal-projects）后，startInterview 必须仍正常返回第一问（问题可见），
// 且档案注入到 prompt（此前"看不到问题"类回归——档案注入把启动弄挂时会在此暴露）
test("startInterview 配置个人项目档案后仍正常返回问题（档案注入不破坏启动）", async () => {
  // 临时假项目：package.json（技术栈）+ 一个源码文件 → 有可注入档案
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const projDir = mkdtempSync(path.join(tmpdir(), "iv-proj-"));
  mkdirSync(path.join(projDir, "src"), { recursive: true });
  writeFileSync(path.join(projDir, "package.json"), JSON.stringify({ name: "iv-proj", dependencies: { react: "^18", express: "^4" }, description: "测试项目" }));
  writeFileSync(path.join(projDir, "src", "server.js"), "const express = require('express');\nconst app = express();\nmodule.exports = app;");
  const { savePersonalProjects } = await import("../lib/personal-projects.mjs");
  savePersonalProjects([{ name: "iv-proj", dir: projDir }]);
  setLlmResponses(FIRST_Q);
  const r = await startInterview({ position: "前端" });
  assert.equal(r.ok, true, "档案注入后 startInterview 仍成功（不抛错）");
  assert.ok(r.question && r.question.length > 0, "返回第一问（问题可见）");
  // prompt 应含项目档案（面试官拷打真实代码）
  const prompt = (await import("./helpers.mjs")).getLastMessages().map((m) => m.content).join("\n");
  assert.ok(prompt.includes("简历项目源码档案"), "档案段注入 prompt");
  assert.ok(prompt.includes("iv-proj") || prompt.includes("react"), "档案内容（项目名/技术栈）出现在 prompt");
  // 清理
  savePersonalProjects([]);
  try { rmSync(projDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("startInterview LLM 返回非法 → 兜底破冰问题", async () => {
  setLlmResponses("乱码");
  const r = await startInterview({ position: "前端" });
  assert.equal(r.ok, true);
  assert.ok(r.question.includes("介绍"), "兜底问题");
});

test("submitAnswer 无进行中面试 → error", async () => {
  const r = await submitAnswer("回答");
  assert.ok(r.error);
});

test("submitAnswer 评分 + 推进下一问", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":80,"expr":70,"depth":60,"edge":50,"reflect":40},"comment":"不错","finish":false,"next_question":"讲讲 React Fiber","next_basis":"切换新题","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r = await submitAnswer("我的回答");
  assert.equal(r.ok, true);
  assert.equal(r.finished, false);
  assert.equal(r.total, 60); // (80+70+60+50+40)/5
  assert.ok(r.question.includes("Fiber"), "下一问");
  assert.equal(memory.getInterview().rounds.length, 1);
});

// ---------- 面试官 agent 化：出题前可检索项目资源（题库/档案/知识库/薄弱点） ----------
const IV_SCORES = '{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_kind":"new","next_question":"讲讲 Promise 的实现","next_basis":"换题","next_dimension":"手写","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":""}';

test("面试官 agent：决策轮调用 search_challenge → 工具结果回填 → 出题轮正常", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 第一次 llmChat：TOOLCALL search_challenge；第二次：出题 JSON
  setLlmResponses('TOOLCALL:{"name":"search_challenge","arguments":"{\\"query\\":\\"Promise\\"}"}', IV_SCORES);
  const r = await submitAnswer("我的回答");
  assert.equal(r.ok, true);
  assert.ok(r.question.includes("Promise"), "基于工具检索结果出题");
  // 出题轮 messages 含 tool 结果回填（role:"tool"）
  const { getLastMessages } = await import("./helpers.mjs");
  const msgs = getLastMessages();
  assert.ok(msgs.some((m) => m.role === "tool"), "工具结果应回填给出题轮");
  assert.ok(msgs.some((m) => m.role === "assistant" && m.tool_calls), "决策轮 tool_calls 消息在列");
});

test("面试官 agent：工具失败（题库无匹配）→ 错误注入 → 出题不中断", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('TOOLCALL:{"name":"search_challenge","arguments":"{\\"query\\":\\"不存在的题目xyz\\"}"}', IV_SCORES);
  const r = await submitAnswer("我的回答");
  assert.equal(r.ok, true, "工具失败不阻塞出题");
  assert.ok(r.question.length > 0, "仍有下一问");
  const { getLastMessages } = await import("./helpers.mjs");
  const msgs = getLastMessages();
  const toolMsg = msgs.find((m) => m.role === "tool");
  assert.ok(toolMsg && toolMsg.content.includes("error"), "错误信息注入工具消息");
});

test("面试官 agent：未知工具名 → 错误回填不崩溃", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('TOOLCALL:{"name":"hack_tool","arguments":"{}"}', IV_SCORES);
  const r = await submitAnswer("我的回答");
  assert.equal(r.ok, true, "未知工具不崩溃");
  assert.ok(r.question.length > 0);
});

test("submitAnswer 低分 + weak_topic → 薄弱点回流", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":false,"next_question":"下一问","next_basis":"追问","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"事件循环"}');
  await submitAnswer("回答");
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "事件循环"), "低分薄弱点回流");
});

test("submitAnswer 伪知识点 weak_topic 不回流", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":false,"next_question":"下一问","next_basis":"追问","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"综合能力"}');
  await submitAnswer("回答");
  assert.equal(memory.getWeakPoints().length, 0, "伪知识点不记录");
});

test("submitAnswer finish → 面试结束", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":90,"expr":90,"depth":90,"edge":90,"reflect":90},"comment":"好","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":""}');
  const r = await submitAnswer("回答");
  assert.equal(r.finished, true);
  assert.equal(memory.getInterview().finished, true);
});

test("endInterview 无面试 → error", async () => {
  const r = await endInterview();
  assert.ok(r.error);
});

test("endInterview 完整流程：报告 + 历史 + 复习卡 + 学习清单回流", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 一轮低分（暴露薄弱点）→ 结束后回流
  setLlmResponses('{"scores":{"tech":40,"expr":40,"depth":40,"edge":40,"reflect":40},"comment":"一般","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":"防抖节流"}');
  await submitAnswer("回答");
  // endInterview 调 LLM 生成报告
  setLlmResponses("## 面试复盘（前端）\n### 总体评价\n准备度中等\n### 具体短板\n防抖节流不熟");
  const r = await endInterview();
  assert.equal(r.ok, true);
  assert.ok(r.report.includes("面试复盘"));
  assert.ok(r.avg < 60);
  // 历史记录
  assert.equal(memory.getInterviewHistory().length, 1);
  // 会话清理
  assert.equal(memory.getInterview(), null);
  // 薄弱点回流 + 复习卡 + 学习清单
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "防抖节流"));
  const { review } = await import("../lib/review.mjs");
  assert.ok(review.getStats().total >= 1, "低分轮自动建复习卡");
  const { getPlan } = await import("../lib/study.mjs");
  assert.ok(getPlan().items.some((i) => i.topic === "防抖节流"), "薄弱点回流学习清单");
});

test("endInterview 无轮次直接结束", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const r = await endInterview();
  assert.equal(r.ok, true);
  assert.equal(memory.getInterview(), null);
});

// ---------- 轮次编排（项目拷打与八股混合，对标 ai-career） ----------
test("startInterview 初始化：轮次编排 + 六态字段", async () => {
  setLlmResponses(FIRST_Q);
  const r = await startInterview({ position: "前端", resume: "简历内容：做过低代码平台" });
  assert.equal(r.ok, true);
  const s = memory.getInterview();
  assert.equal(s.roundIndex, 0, "从开场轮开始");
  assert.equal(s.isPreparing, true);
  assert.equal(s.isCompleted, false);
  assert.ok(s.resume.includes("低代码平台"), "简历传入");
});

test("submitAnswer 推进轮次：返回下一轮类型", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端", resume: "做过 AI 助手项目" });
  setLlmResponses('{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_kind":"stage","next_question":"讲讲项目架构","next_basis":"项目追问","next_dimension":"架构","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r = await submitAnswer("项目是我设计的");
  assert.equal(r.ok, true);
  assert.equal(r.roundType, "开场与自我介绍", "本轮类型正确");
  assert.equal(r.stage, "项目拷打", "下一轮进入项目拷打");
  assert.equal(memory.getInterview().roundIndex, 1, "轮次索引推进（stage）");
});

test("submitAnswer 未知 next_kind → 保守按 new（本轮内换题，不吞轮次）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_kind":"乱写的值","next_question":"换个问题","weak_topic":""}');
  const r = await submitAnswer("回答");
  assert.equal(r.ok, true);
  assert.equal(memory.getInterview().roundIndex, 0, "未知 next_kind 不推进轮次（保守 new）");
});

test("全部轮次结束 → finished", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 模拟最后一轮（roundIndex 到末尾）→ finish
  setLlmResponses('{"scores":{"tech":80,"expr":80,"depth":80,"edge":80,"reflect":80},"comment":"好","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":""}');
  // 把 roundIndex 推到末尾前
  const s = memory.getInterview();
  // ROUND_SEQ 长度从 interview.mjs 导出？直接推进到接近末尾：手动设置
  s.roundIndex = 100; // 超过长度 → 判定结束
  memory.setInterview(s);
  const r = await submitAnswer("回答");
  assert.equal(r.finished, true);
  assert.equal(memory.getInterview().isCompleted, true);
});

// ---------- 薄弱点队列（八股轮优先出题 + weak_hit 标记） ----------
test("startInterview 返回薄弱点队列与 depth", async () => {
  memory.addWeakPoint("事件循环", "测试", "agent");
  memory.addWeakPoint("React Hooks", "测试", "agent");
  setLlmResponses(FIRST_Q);
  const r = await startInterview({ position: "前端" });
  assert.equal(r.ok, true);
  assert.equal(r.depth, 0);
  assert.ok(Array.isArray(r.weakQueue), "返回 weakQueue");
  assert.ok(r.weakQueue.some((w) => w.topic === "事件循环" && w.failCount >= 1));
  const s = memory.getInterview();
  assert.equal(s.weakQueue.length, 2, "会话持久化队列");
  assert.ok(s.weakQueue.every((w) => w.asked === false));
});

test("submitAnswer weak_hit 命中 → 标记已考察，本场不重复命中", async () => {
  memory.addWeakPoint("事件循环", "测试", "agent");
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 第一轮命中事件循环
  setLlmResponses('{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_question":"下一问","next_basis":"切换新题","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":"事件循环"}');
  const r1 = await submitAnswer("回答");
  assert.equal(r1.weakHit, true, "命中标记");
  assert.equal(r1.weakTopic, "事件循环");
  const s1 = memory.getInterview();
  assert.equal(s1.weakQueue.find((w) => w.topic === "事件循环").asked, true, "已标记 asked");
  // 第二轮 LLM 再报同一主题 → 不应重复命中
  setLlmResponses('{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_question":"下一问","next_basis":"切换新题","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":"事件循环"}');
  const r2 = await submitAnswer("回答");
  assert.equal(r2.weakHit, false, "已考察主题不重复命中");
});

test("submitAnswer weak_hit 非队列项 → 不命中", async () => {
  memory.addWeakPoint("事件循环", "测试", "agent");
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_question":"下一问","next_basis":"切换新题","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":"Vue 原理"}');
  const r = await submitAnswer("回答");
  assert.equal(r.weakHit, false, "非队列项不命中");
  assert.equal(memory.getInterview().weakQueue[0].asked, false);
});

test("endInterview 返回薄弱点覆盖统计", async () => {
  memory.addWeakPoint("事件循环", "测试", "agent");
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":50,"expr":50,"depth":50,"edge":50,"reflect":50},"comment":"一般","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":"","weak_hit":"事件循环"}');
  await submitAnswer("回答");
  setLlmResponses("## 面试复盘（前端）\n### 总体评价\n中等");
  const r = await endInterview();
  assert.equal(r.ok, true);
  assert.equal(r.weakTotal, 1);
  assert.equal(r.weakCovered, 1, "命中 1 个薄弱点");
  assert.deepEqual(r.weakCoveredTopics, ["事件循环"]);
});

// ---------- 轮次编排（next_kind 三态：追问不耗轮 / 深度上限硬约束 / 八股轮必然到达） ----------
const FOLLOWUP_RESP = '{"scores":{"tech":60,"expr":60,"depth":60,"edge":60,"reflect":60},"comment":"有漏洞","finish":false,"next_kind":"followup","next_question":"再讲细一点：宏任务和微任务的顺序","next_basis":"追问","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":""}';

test("next_kind=followup → 追问不推进轮次（同一轮深挖，round 不变）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses(FOLLOWUP_RESP);
  const r = await submitAnswer("回答");
  assert.equal(r.ok, true);
  assert.equal(r.depth, 1, "追问深度 +1");
  assert.equal(r.round, 1, "仍是第 1 轮（追问不增加轮数）");
  const s = memory.getInterview();
  assert.equal(s.roundIndex, 0, "轮次索引不推进");
  assert.equal(s.current.round, 1, "会话内 round 不变");
  assert.equal(s.current.depth, 1);
});

test("追问链连续 6 次后 LLM 仍返回 followup → 服务端安全阀强制推进（防死循环，正常按质量判断不会走到）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const s = memory.getInterview();
  s.current.depth = 6; // 已到 MAX_DEPTH（安全阀）
  memory.setInterview(s);
  setLlmResponses(FOLLOWUP_RESP); // LLM 不守规矩仍要追问
  const r = await submitAnswer("回答");
  assert.equal(r.depth, 0, "深度归 0（超限强制切新题）");
  assert.equal(memory.getInterview().roundIndex, 1, "轮次推进（不卡死在追问链）");
});

test("next_kind=new → 本轮内换新题，深度归 0，不推进轮次（与 prompt 语义一致）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":80,"expr":80,"depth":80,"edge":80,"reflect":80},"comment":"可以","finish":false,"next_kind":"new","next_question":"项目里另一个难点是什么","next_basis":"换题","next_dimension":"项目","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":""}');
  const r = await submitAnswer("回答");
  assert.equal(r.depth, 0, "新题深度归 0");
  assert.equal(r.round, 1, "返回的 round 是当前轮（本轮编号）");
  assert.equal(memory.getInterview().current.round, 1, "会话内下一问仍是本轮（new=本轮内换题，不 +1）");
  assert.equal(memory.getInterview().roundIndex, 0, "轮次不推进（new 与 prompt 语义一致，仅 stage 推进）");
});

test("轮次推进到底 → 八股轮必然到达（ROUND_SEQ[3] 是八股穿插）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const s = memory.getInterview();
  s.roundIndex = 3; // 直接定位到八股穿插轮（ROUND_SEQ: open, project×2, tech八股, project回马枪, tech, coding×2, reverse）
  memory.setInterview(s);
  setLlmResponses('{"scores":{"tech":70,"expr":70,"depth":70,"edge":70,"reflect":70},"comment":"可以","finish":false,"next_kind":"stage","next_question":"下一阶段第一问","next_basis":"进入下一阶段","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"","weak_hit":""}');
  const r = await submitAnswer("回答");
  assert.equal(r.roundType, "八股穿插", "本轮类型应为八股（ROUND_SEQ[3]）");
  assert.equal(r.stage, "项目拷打·回马枪", "下一轮衔接正确");
});

test("endInterview：复习卡 answer 回填候选人回答 + 薄弱点 failCount 单记（Bug#2/#3 回归）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":true,"next_kind":"stage","weak_topic":"事件循环"}');
  const r = await submitAnswer("宏任务先执行，微任务后执行，这是我的回答");
  assert.equal(r.ok, true);
  // submit 时已建卡（answer 空）
  let card = review.loadCards().cards.find((c) => c.topic === "事件循环");
  assert.ok(card, "submit 时建卡");
  assert.equal(card.answer, "", "submit 时 answer 为空（当时无回答）");
  await endInterview();
  card = review.loadCards().cards.find((c) => c.topic === "事件循环");
  assert.ok(card && card.answer.includes("宏任务先执行"), "end 后 answer 回填候选人回答（Bug#3）");
  const weak = memory.getTrustedWeakPoints(10).find((w) => w.topic === "事件循环");
  assert.equal(weak?.failCount, 1, "failCount 单记（Bug#2 不双记）");
});

test("startInterview 优先考察多源聚合：题库错题/复习错题/今日复习/清单未完成/薄弱点", async () => {
  const { addPlanItems } = await import("../lib/study.mjs");
  const { db } = await import("../lib/db.mjs");
  // 1) 题库错题（wrong_count>0）
  db.prepare("INSERT OR REPLACE INTO challenges (id, title, category, difficulty, frequency, time_limit, description, skeleton, test_code, source, created_at) VALUES ('algo1','算法错题A','algorithm',2,3,15,'d','s','t','test',?)").run(Date.now());
  db.prepare("UPDATE challenges SET wrong_count=3 WHERE id='algo1'").run();
  // 2) 复习卡错题（答错≥2 次）
  review.addCard({ topic: "复习错题B", question: "q", answer: "", source: "测试" });
  const cardB = review.loadCards().cards.find((c) => c.topic === "复习错题B");
  review.reviewCard(cardB.id, 0);
  review.reviewCard(cardB.id, 0);
  // 3) 今日复习主题
  review.addCard({ topic: "今日复习C", question: "q", answer: "", source: "测试" });
  const cardC = review.loadCards().cards.find((c) => c.topic === "今日复习C");
  review.reviewCard(cardC.id, 2);
  // 4) 清单未完成
  addPlanItems([{ topic: "清单未完成D", why: "w", source: "测试" }]);
  // 5) 薄弱点（fail=2）
  memory.addWeakPoint("薄弱点E", "模拟面试", "agent");
  memory.addWeakPoint("薄弱点E", "模拟面试", "agent");

  setLlmResponses(FIRST_Q);
  const r = await startInterview({ position: "前端" });
  const topics = r.weakQueue.map((w) => w.topic);
  assert.ok(topics.includes("算法错题A"), "题库错题入队列");
  assert.ok(topics.includes("复习错题B"), "复习错题入队列");
  assert.ok(topics.includes("今日复习C"), "今日复习入队列");
  assert.ok(topics.includes("清单未完成D"), "清单未完成入队列");
  assert.ok(topics.includes("薄弱点E"), "薄弱点入队列");
  assert.ok(r.weakQueue.some((w) => w.topic === "算法错题A" && w.reason), "带来源原因");
  // 优先级：薄弱点(fail2) > 复习错题 > 题库错题 > 今日复习 > 清单
  const idx = (t) => topics.indexOf(t);
  assert.ok(idx("薄弱点E") < idx("复习错题B"), "薄弱点优先");
  assert.ok(idx("复习错题B") < idx("算法错题A"), "复习错题优先于题库错题");
  assert.ok(idx("算法错题A") < idx("清单未完成D"), "题库错题优先于清单");
});

test("质量服务端兜底：低分+stage → 强制追问；高分+followup → 放行不纠缠（Bug#5）", async () => {
  // 低分（30）+ LLM 说 stage → 服务端强制 followup（tech 轮）
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":false,"next_kind":"stage","next_question":"下一问","next_basis":"b","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r1 = await submitAnswer("不太会");
  assert.equal(r1.depth, 1, "低分强制追问（depth=1）");
  assert.equal(memory.getInterview().roundIndex, 0, "低分强制追问不推进轮次");
  // 高分（80）+ LLM 说 followup → 服务端放行（改 new 本轮换题，不追问）
  setLlmResponses('{"scores":{"tech":80,"expr":80,"depth":80,"edge":80,"reflect":80},"comment":"很好","finish":false,"next_kind":"followup","next_question":"下一题","next_basis":"b","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r2 = await submitAnswer("我很懂");
  assert.equal(r2.depth, 0, "高分不追问（depth=0）");
  assert.equal(memory.getInterview().roundIndex, 0, "高分放行本轮换题（不推进不纠缠）");
});
