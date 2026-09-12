// interview.mjs 单测：模拟面试全流程（mock LLM + 临时 DB）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables, mockLLM, setLlmResponses } from "./helpers.mjs";

const dbDir = setupTempDb("interview");
mockLLM();
const { startInterview, submitAnswer, endInterview, getInterviewStatus } = await import("../lib/interview.mjs");
const { db } = await import("../lib/db.mjs");
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
// 且**本地项目源码不进面试上下文**（用户反馈 2026-09：面试官拿本地源码刨文件名/函数实现，
// "正常一般不会查这么细，还是根据简历来吧"）——项目拷打只看简历
test("startInterview 配置个人项目档案后仍正常返回问题（面试上下文不含本地源码）", async () => {
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
  const r = await startInterview({ position: "前端", resume: "简历：独立开发 CareerPilot（Next.js + CodeMirror），负责简历诊断与模拟面试模块" });
  assert.equal(r.ok, true, "档案配置后 startInterview 仍成功（不抛错）");
  assert.ok(r.question && r.question.length > 0, "返回第一问（问题可见）");
  // prompt：简历是唯一项目依据；不含本地源码信息
  const prompt = (await import("./helpers.mjs")).getLastMessages().map((m) => m.content).join("\n");
  assert.ok(prompt.includes("项目拷打的唯一依据"), "简历是项目拷打依据（出题以简历为准）");
  assert.ok(prompt.includes("看不到候选人的代码") || prompt.includes("看不到"), "明确告知面试官看不到代码");
  // 项目上下文段（简历段）里不得有任何本地源码档案痕迹（output/ 下历史学习文档是另一段素材，不属项目上下文）
  const projectCtx = prompt.slice(prompt.indexOf("候选人简历（"), prompt.indexOf("请生成面试的"));
  assert.ok(projectCtx.length > 0, "简历段存在");
  assert.ok(!projectCtx.includes("【源码结构】") && !projectCtx.includes("【核心源码预览】"), "项目上下文不含本地源码/目录结构");
  assert.ok(!prompt.includes("iv-proj"), "本地项目名不进面试上下文");
  assert.ok(!prompt.includes(projDir), "本地项目路径不进面试上下文");
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

test("getInterviewStatus：进行中返回可续数据，结束后 active:false（继续上一场入口）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const s = await getInterviewStatus();
  assert.equal(s.ok, true);
  assert.equal(s.active, true);
  assert.equal(s.round, 1);
  assert.ok(s.question.includes("事件循环"), "当前问题可续");
  assert.equal(s.roundsCount, 0);
  assert.equal(s.totalRounds, 9);
  assert.equal(typeof s.roundType, "string");
  // 结束（清会话）后失活
  memory.clearInterview();
  const s2 = await getInterviewStatus();
  assert.equal(s2.ok, true);
  assert.equal(s2.active, false);
});

test("submitAnswer 学习计划埋点：learning_events 写入 kind=interview", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":80,"expr":70,"depth":60,"edge":50,"reflect":40},"comment":"不错","finish":false,"next_question":"讲讲 React Fiber","next_basis":"x","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":"事件循环"}');
  const r = await submitAnswer("我的回答");
  assert.equal(r.ok, true);
  const ev = db.prepare("SELECT topic, kind, result, quality FROM learning_events WHERE kind='interview'").all();
  assert.equal(ev.length, 1, "面试每轮写入学习事件流");
  // topic 优先取本轮薄弱知识点名
  assert.equal(ev[0].topic, "事件循环");
  assert.equal(ev[0].result, "pass", "total=60 → pass（阈值口径与薄弱点回流一致）");
  assert.equal(ev[0].quality, 0.6);
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

test("B2 修复：字符串/缺维度评分 → 不 NaN、薄弱点回流不被静默阻断", async () => {
  // 脏 LLM 输出：tech 是字符串 "80分"、reflect 缺失（此前 → total=NaN → 回流恒 false）
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":"80分","expr":30,"depth":30,"edge":30},"comment":"脏","finish":false,"next_question":"下一问","next_basis":"追问","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":"防抖节流"}');
  const r = await submitAnswer("回答");
  assert.ok(Number.isFinite(r.total), `total 不 NaN（实际 ${r.total}）`);
  assert.ok(r.total <= 100 && r.total >= 0, "total 在 0-100（缺维度按 0 + clamp）");
  const weak = memory.getWeakPoints();
  assert.ok(weak.some((w) => w.topic === "防抖节流"), "低分薄弱点回流正常（未被 NaN 阻断）");
});

test("B2 修复：越界维度 clamp 到 0-100（合法输入分数不变）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // tech=150 越界 → clamp 100；expr 等合法值不变
  setLlmResponses('{"scores":{"tech":150,"expr":70,"depth":60,"edge":50,"reflect":40},"comment":"c","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":""}');
  const r = await submitAnswer("回答");
  assert.ok(Number.isFinite(r.total), "不 NaN");
  assert.ok(r.total <= 100, `clamp 生效（total=${r.total} ≤ 100）`);
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
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":true,"next_kind":"stage","weak_topic":"事件循环"}', "补充内容"); // submitAnswer 内部 2 次 LLM 调用（防 mock 队列空假绿）
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
  // 低分（30）+ LLM 说 stage → 服务端强制 followup（tech 轮）——回答含糊但**没有明确放弃**
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":false,"next_kind":"stage","next_question":"下一问","next_basis":"b","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r1 = await submitAnswer("宏任务和微任务吧，大概是这么个顺序，具体没细看");
  assert.equal(r1.depth, 1, "低分强制追问（depth=1）");
  assert.equal(memory.getInterview().roundIndex, 0, "低分强制追问不推进轮次");
  // 高分（80）+ LLM 说 followup → 服务端放行（改 new 本轮换题，不追问）
  setLlmResponses('{"scores":{"tech":80,"expr":80,"depth":80,"edge":80,"reflect":80},"comment":"很好","finish":false,"next_kind":"followup","next_question":"下一题","next_basis":"b","next_dimension":"d","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r2 = await submitAnswer("我很懂");
  assert.equal(r2.depth, 0, "高分不追问（depth=0）");
  assert.equal(memory.getInterview().roundIndex, 0, "高分放行本轮换题（不推进不纠缠）");
});

// ---------- 用户反馈（2026-09）：明确说"忘了/不会"就该换题，不再拷打同一题 ----------
test("isGiveUpAnswer：明确放弃识别（短回答命中；长回答里的转折不算）", async () => {
  const { isGiveUpAnswer } = await import("../lib/interview-session.mjs");
  for (const a of ["忘了", "这个我不记得了", "没做过这个", "不太会", "不会，跳过吧", ""]) {
    assert.equal(isGiveUpAnswer(a), true, `「${a}」应判为放弃`);
  }
  const long = "这块我确实不知道细节，但我可以从整体设计上讲：我们用的是三阶段状态机，plan/round/review 分别对应简历输入、AI 规划与复盘生成，用 Zustand selector 管理五阶段状态，其中动态追问和手写穿插是两条独立的链路，SSE 流式复盘单独走一条通道……" + "补充说明细节若干".repeat(6);
  assert.ok(long.replace(/\s+/g, "").length > 120, "长回答样本需超阈值");
  assert.equal(isGiveUpAnswer(long), false, "长回答里的'不知道'是转折，不算放弃");
  assert.equal(isGiveUpAnswer("事件循环是宏任务与微任务的调度机制，先执行同步代码再清空微任务队列"), false, "正常回答不算放弃");
});

test("明确放弃（低分 + next_kind=followup）→ 服务端强制换题（depth 归 0，不重复同一题）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // LLM 还想追问（followup）+ 低分 —— 但候选人明确说忘了 → 必须换题
  setLlmResponses('{"scores":{"tech":20,"expr":20,"depth":20,"edge":20,"reflect":20},"comment":"不会","finish":false,"next_kind":"followup","next_question":"那再讲讲这个知识点的底层原理","next_basis":"追问","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r = await submitAnswer("忘了，这题我不会");
  assert.equal(r.ok, true);
  assert.equal(r.gaveUp, true, "标记候选人放弃");
  assert.equal(r.depth, 0, "不再追问（depth 归 0）");
  assert.equal(memory.getInterview().current.round, 1, "同轮内换题（不推进轮次）");
  assert.ok(r.question.includes("底层原理"), "仍用 LLM 给出的新题（换题而非重复原题）");
});

test("明确放弃 + LLM 未给新题 → 兜底不重复原题（引导到别的知识点）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":10,"expr":10,"depth":10,"edge":10,"reflect":10},"comment":"不会","finish":false,"next_kind":"followup","next_question":"","weak_topic":""}');
  const r = await submitAnswer("没做过");
  assert.equal(r.ok, true);
  assert.equal(r.depth, 0, "放弃后不追问");
  assert.ok(!r.question.includes("事件循环"), "兜底问题不重复原题");
  assert.ok(r.question.includes("换个方向"), "兜底换题文案");
});

// ---------- 模拟面试 agent 化工单任务 6：循环内 tool_calls / messages 累积 / 兜底 ----------
test("agent化①：循环内 tool_calls——LLM 先调工具（查题库）→ 结果回填 → 再出题", async () => {
  setLlmResponses(
    `TOOLCALL:${JSON.stringify({ name: "search_challenge", arguments: JSON.stringify({ query: "链表反转" }) })}`,
    '{"scores":{"tech":60,"expr":60,"depth":60,"edge":60,"reflect":60},"comment":"中规中矩","finish":false,"next_kind":"stage","next_question":"手写链表反转","weak_topic":""}'
  );
  await startInterview({ position: "前端" });
  const r = await submitAnswer("我的自我介绍和项目经历");
  assert.equal(r.ok, true);
  assert.ok(r.question.includes("链表反转"), "工具结果影响出题（查题库后出题）");
});

test("agent化②：messages 累积——多轮后上下文含全部历史（不重构造）", async () => {
  setLlmResponses(
    '{"scores":{"tech":60,"expr":60,"depth":60,"edge":60,"reflect":60},"comment":"ok","finish":false,"next_kind":"stage","next_question":"第二轮问题","weak_topic":""}',
    '{"scores":{"tech":60,"expr":60,"depth":60,"edge":60,"reflect":60},"comment":"ok","finish":false,"next_kind":"stage","next_question":"第三轮问题","weak_topic":""}',
    '{"scores":{"tech":60,"expr":60,"depth":60,"edge":60,"reflect":60},"comment":"ok","finish":false,"next_kind":"stage","next_question":"第四轮问题","weak_topic":""}'
  );
  await startInterview({ position: "前端" });
  await submitAnswer("第一轮回答");
  const r2 = await submitAnswer("第二轮回答");
  assert.equal(r2.ok, true);
  const session = (await import("../lib/memory.mjs")).memory.getInterview();
  assert.ok(session.messages && session.messages.length >= 4, "messages 累积（system+多轮 user/assistant）");
});

test("agent化⑤：next_question 空 → 兜底追问（不再'请继续'）", async () => {
  setLlmResponses(
    '{"scores":{"tech":40,"expr":40,"depth":40,"edge":40,"reflect":40},"comment":"差","finish":false,"next_kind":"followup","next_question":"","weak_topic":""}',
    '{"scores":{"tech":40,"expr":40,"depth":40,"edge":40,"reflect":40},"comment":"差","finish":false,"next_kind":"followup","next_question":"","weak_topic":""}'
  );
  await startInterview({ position: "前端" });
  const r = await submitAnswer("回答得不好");
  assert.equal(r.ok, true);
  assert.ok(!r.question.includes("请继续。"), "不再'请继续。'（空兜底）");
  assert.ok(r.question.includes("深入讲讲"), "兜底追问（基于当前问题）");
});

// ---------- 回归（2026-09 真实事故）：工具轮打满 → 强制收口出题 ----------
// 现场：模型每轮连续 4 次只调工具、始终不出 JSON → raw 空 → total=0 + 兜底"请继续"，
// 面试官连续 7 轮卡在同一题，评分全 0（trace_llm 可见每轮 4 连击 tool_calls）
const TOOL_CALL_RESP = `TOOLCALL:${JSON.stringify({ name: "search_challenge", arguments: JSON.stringify({ query: "防抖" }) })}`;

test("回归：LLM 连续只调工具（工具轮打满）→ 强制收口仍拿到评分与下一问（不 0 分空转）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 3 次 TOOLCALL（超过工具轮上限 2）→ 第 3 次是强制收口调用；随后 1 次为无工具兜底（后端忽略 tool_choice 场景）
  setLlmResponses(TOOL_CALL_RESP, TOOL_CALL_RESP, TOOL_CALL_RESP, IV_SCORES);
  const r = await submitAnswer("我只知道大概思路");
  assert.equal(r.ok, true, "工具轮打满不阻塞面试推进");
  assert.equal(r.total, 70, "评分来自强制收口的 JSON（此前 raw 空 → total=0）");
  assert.ok(r.question.includes("Promise"), "下一问来自强制收口的 JSON（不再空转'请继续'）");
  assert.equal(memory.getInterview().rounds.length, 1, "本轮正常入账（不产生 0 分空转轮）");
});

test("回归：强制收口也拿不到 JSON → 返回可重试错误，不写 0 分轮", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 工具轮 2 次 + 强制收口 1 次 + 无工具兜底 1 次，全部都不是 JSON
  setLlmResponses(TOOL_CALL_RESP, TOOL_CALL_RESP, TOOL_CALL_RESP, "抱歉，我无法评分");
  const r = await submitAnswer("回答");
  assert.ok(r.error && r.retry === true, `返回可重试错误（实际 ${JSON.stringify(r)}）`);
  assert.equal(memory.getInterview().rounds.length, 0, "不写 0 分空转轮（此前会记一轮 0 分并重复同一题）");
});

// ---------- 伪知识点过滤统一工单任务 4：cleanWeakTopic 委托 _cleanTopic（单一实现） ----------
test("cleanWeakTopic 委托 _cleanTopic：题目占位符/测试残留被拦截（此前两套模式漏拦）", async () => {
  const { cleanWeakTopic } = await import("../lib/interview-scoring.ts");
  assert.equal(cleanWeakTopic("题1【二叉树遍历（DFS/BFS）】"), null, "题目占位符拦截（_cleanTopic 模式）");
  assert.equal(cleanWeakTopic("到期新卡"), null, "测试残留拦截");
  assert.equal(cleanWeakTopic("综合能力"), null, "泛化标签拦截");
  assert.equal(cleanWeakTopic("事件循环"), "事件循环", "正常知识点保留");
  const long = "这是一个超过三十个字符的知识点名字用来测试过滤逻辑是否正常工作的例子";
  assert.equal(cleanWeakTopic(long), long.slice(0, 30), "超长截断保留前 30 字（_cleanTopic 口径）");
});

// ---------- 架构 P1-1：会话治理（idle 超时 + 并发写保护） ----------
test("P1-1：idle 超时（30 分钟无活动）→ submitAnswer 自动结束会话", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  // 模拟 31 分钟无活动：直接改内存镜像的 updatedAt（setInterview 会打新时间戳，绕开它）
  memory.getInterview().updatedAt = Date.now() - 31 * 60 * 1000;
  const r = await submitAnswer("迟到的回答");
  assert.ok(r.error && r.error.includes("超时"), "返回超时错误");
  assert.equal(memory.getInterview(), null, "会话已被自动清除");
});

test("P1-1：idle 超时 → getInterviewStatus 返回 expired:false active", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  memory.getInterview().updatedAt = Date.now() - 31 * 60 * 1000;
  const s = await getInterviewStatus();
  assert.equal(s.active, false, "过期会话视为无会话");
  assert.equal(s.expired, true, "标记 expired");
  assert.equal(memory.getInterview(), null, "过期会话被清理");
});

test("P1-1：idle 未超时 → submitAnswer 正常（updatedAt 自动更新）", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  assert.ok(memory.getInterview().updatedAt, "setInterview 自动打 updatedAt");
  setLlmResponses('{"scores":{"tech":80,"expr":70,"depth":60,"edge":50,"reflect":40},"comment":"不错","finish":false,"next_question":"讲讲 React Fiber","next_basis":"x","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":""}');
  const r = await submitAnswer("正常回答");
  assert.equal(r.ok, true, "未超时会话正常推进");
});

test("P1-1：并发写保护——LLM 调用期间会话被替换 → 拒绝写入不覆盖", async () => {
  setLlmResponses(FIRST_Q);
  await startInterview({ position: "前端" });
  const { setLlmDelay } = await import("./helpers.mjs");
  setLlmDelay(50); // 延迟 LLM mock：复现真实调用耗时——给并发替换留窗口
  try {
    const before = memory.getInterview();
    setLlmResponses('{"scores":{"tech":80,"expr":70,"depth":60,"edge":50,"reflect":40},"comment":"不错","finish":false,"next_question":"讲讲 React Fiber","next_basis":"x","next_dimension":"原理","next_criteria":"c","next_boundary":"b","weak_topic":""}');
    const p = submitAnswer("我的回答"); // 不 await
    await new Promise((r) => setTimeout(r, 20)); // 等待 submitAnswer 进入 LLM 调用（延迟 mock 内）
    memory.setInterview({ position: "并发面试", role: "技术深挖型", rounds: [], current: { round: 1 }, finished: false }); // 并发替换
    const result = await p;
    assert.ok(result.concurrent === true || (result.error && result.error.includes("并发")), `返回并发拒绝（实际: ${JSON.stringify(result)}）`);
    const after = memory.getInterview();
    assert.equal(after.position, "并发面试", "并发会话未被覆盖");
    assert.equal(before.rounds.length, 0, "原会话未写脏（rounds 未追加）");
  } finally {
    setLlmDelay(0); // 恢复（影响后续测试）
  }
});



