// Agent/Harness 能力评测（Layer B）：mock LLM 故障注入，与模型水平无关
// 测的是 harness 本身：工具循环/参数校验/容错/压缩/记忆闭环/搜索过滤
// 换任何模型跑结果一致（LLM 被 mock 固定响应，验证的是 agent 机制）
// 用法: node --experimental-test-module-mocks scripts/benchmark-agent.mjs [--no-save]
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockLLM, mockFetchPage, setLlmResponses, setMockPages, setupTempDb } from "../tests/helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NO_SAVE = process.argv.includes("--no-save");

// 隔离临时库（必须在 import 被测模块前）
setupTempDb("bench-agent");
mockLLM();
mockFetchPage();

const { chatWithAgent, toolSearchPosts } = await import("../lib/agent.mjs");
const { memory } = await import("../lib/memory.mjs");
const { review } = await import("../lib/review.mjs");
const { getPlan, addPlanItems, answerReview } = await import("../lib/study.mjs");
const { startInterview, submitAnswer, endInterview } = await import("../lib/interview.mjs");
const { db } = await import("../lib/db.mjs");
const { getRecentTools } = await import("../lib/trace.mjs");
const { getPendingApprovals, resolveApproval } = await import("../lib/permission.mjs");

/** 模拟用户在面板批准 confirm 级工具的审批请求（deny-first 权限系统） */
async function autoApproveDuring(task) {
  const checker = setInterval(() => {
    for (const a of getPendingApprovals()) resolveApproval(a.toolName, { allow: true, session: false });
  }, 50);
  try {
    return await task();
  } finally {
    clearInterval(checker);
  }
}

// 场景框架
const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}
async function resetState() {
  for (const t of ["settings", "interests", "seen_urls", "chat_history", "weak_points", "mastered_points",
    "interview_history", "study_plan_items", "review_cards", "card_reviews", "kp_mastery", "trace_llm", "trace_tools"]) {
    db.exec(`DELETE FROM ${t}`);
  }
  const m = memory.get();
  m.profile = { name: "", target: "前端秋招", level: "unknown" };
  m.interests = []; m.seenUrls = []; m.chatHistory = []; m.weakPoints = []; m.masteredPoints = [];
  m.studyProgress = {}; m.interview = null; m.interviewHistory = [];
  m.stats = { chats: 0, questionsSolved: 0, reviewsDone: 0, interviewsDone: 0, lastActive: "" };
  setMockPages([]);
}

// ========== 场景 1-6：工具循环 / 参数校验 / 容错 / 压缩 / 记忆 / 语音 ==========
scenario("工具循环：LLM 决定调工具 → harness 执行并回填 → 最终回答", async () => {
  await resetState();
  setLlmResponses(
    'TOOLCALL:{"name":"plan_task","arguments":"{\\"goal\\":\\"g\\",\\"steps\\":[\\"s1\\"]}"}',
    "执行完毕。"
  );
  const r = await chatWithAgent("帮我规划");
  const tools = getRecentTools(10);
  return { ok: r.reply === "执行完毕。" && tools.some((t) => t.tool_name === "plan_task" && t.ok), detail: `回复:${r.reply.slice(0, 12)} 工具记录:${tools.filter((t) => t.tool_name === "plan_task").length}` };
});

scenario("参数校验：LLM 传缺参 → validateArgs 拦截，不执行工具", async () => {
  await resetState();
  setLlmResponses(
    'TOOLCALL:{"name":"solve_question","arguments":"{}"}',
    "我重新组织回答。"
  );
  const r = await chatWithAgent("讲讲事件循环");
  const tools = getRecentTools(10);
  const bad = tools.find((t) => t.tool_name === "solve_question");
  return { ok: !bad.ok && !!bad.error, detail: `拦截原因:${bad?.error?.slice(0, 30)}` };
});

scenario("未知工具：LLM 幻觉工具名 → 报错不崩溃", async () => {
  await resetState();
  setLlmResponses('TOOLCALL:{"name":"不存在的工具","arguments":"{}"}', "好的。");
  const r = await chatWithAgent("x");
  return { ok: r.reply.length > 0, detail: `回复:${r.reply.slice(0, 10)}` };
});

scenario("记忆写入：remember 工具 → 关注点持久化", async () => {
  await resetState();
  setLlmResponses('TOOLCALL:{"name":"remember","arguments":"{\\"topics\\":[\\"React\\"]}"}', "记住啦。");
  await chatWithAgent("关注 React");
  return { ok: memory.getInterests().includes("React"), detail: `interests:${memory.getInterests().join(",")}` };
});

scenario("上下文压缩：长对话触发 compaction 且回答正常", async () => {
  await resetState();
  setLlmResponses("这是超过二十个字符的对话摘要内容用于压缩流程测试", "压缩后正常回答。");
  const longHistory = [];
  for (let i = 0; i < 32; i++) {
    longHistory.push({ role: "user", content: `历史${i}` + "事件循环原理内容".repeat(60) });
    longHistory.push({ role: "assistant", content: `回答${i}` + "宏任务微任务详解".repeat(60) });
  }
  const r = await chatWithAgent("新问题", longHistory);
  return { ok: r.reply === "压缩后正常回答。", detail: `回复:${r.reply.slice(0, 12)}` };
});

scenario("语音稿分离：【语音】标记正确解析", async () => {
  await resetState();
  setLlmResponses("结论在这里【语音】很简单哦~");
  const r = await chatWithAgent("hi");
  return { ok: r.voice === "很简单哦~" && !r.reply.includes("【语音】"), detail: `voice:${r.voice}` };
});

// ========== 场景 7-9：学习闭环数据流（mock LLM 驱动，断言 DB 数据） ==========
scenario("闭环-面试实录：被问住的知识点 → 学习清单(必会) + 复习卡", async () => {
  await resetState();
  setLlmResponses('TOOLCALL:{"name":"record_interview_topics","arguments":"{\\"topics\\":[\\"事件循环\\",\\"综合能力\\"],\\"company\\":\\"字节\\"}"}', "记好啦。");
  await autoApproveDuring(() => chatWithAgent("面试被问住了事件循环"));
  const plan = getPlan();
  const inPlan = plan.items.some((i) => i.topic === "事件循环" && i.level === "必会");
  const pseudoSkipped = !plan.items.some((i) => i.topic === "综合能力");
  const card = review.getStats().total >= 1;
  return { ok: inPlan && pseudoSkipped && card, detail: `清单:${plan.items.map((i) => i.topic).join("、")} 卡数:${review.getStats().total}` };
});

scenario("闭环-复盘判分：错题 → 薄弱点回流 + 标记已复盘", async () => {
  await resetState();
  addPlanItems([{ topic: "事件循环", why: "w", source: "s", verify_question: "q", level: "必会" }]);
  const item = getPlan().items[0];
  setLlmResponses('{"results":[{"topic":"事件循环","verdict":"错","comment":"浅","reference":"要点"}]}');
  await answerReview([{ id: item.id, answer: "我的回答" }]);
  const weak = memory.getWeakPoints().some((w) => w.topic === "事件循环");
  const reviewed = getPlan().items[0].reviewed === true;
  return { ok: weak && reviewed, detail: `薄弱点:${memory.getWeakPoints().map((w) => w.topic).join(",")} reviewed:${reviewed}` };
});

scenario("闭环-模拟面试：低分轮 → 复盘报告 + 薄弱点 + 复习卡 + 清单回流", async () => {
  await resetState();
  setLlmResponses('{"question":"讲讲事件循环","basis":"高频","dimension":"原理","criteria":"要点","boundary":"边界"}');
  await startInterview({ position: "前端" });
  setLlmResponses('{"scores":{"tech":30,"expr":30,"depth":30,"edge":30,"reflect":30},"comment":"差","finish":true,"next_question":"","next_basis":"","next_dimension":"","next_criteria":"","next_boundary":"","weak_topic":"防抖节流"}');
  await submitAnswer("回答");
  setLlmResponses("## 面试复盘\n### 总体评价\n中等\n### 短板\n防抖不熟");
  const r = await endInterview();
  const weak = memory.getWeakPoints().some((w) => w.topic === "防抖节流");
  const card = review.getStats().total >= 1;
  const planAdded = getPlan().items.some((i) => i.topic === "防抖节流");
  const history = memory.getInterviewHistory().length === 1;
  const cleared = memory.getInterview() === null;
  return { ok: weak && card && planAdded && history && cleared && r.ok, detail: `报告:${r.report?.slice(0, 12) || "无"} 薄弱点:${weak} 卡:${card} 清单:${planAdded} 历史:${history}` };
});

// ========== 场景 10：搜索过滤（mock 页面，测确定性逻辑） ==========
scenario("搜索过滤：方向排除 + 跨源去重 + 已看跳过", async () => {
  await resetState();
  memory.markSeen("https://www.nowcoder.com/discuss/333");
  setMockPages([
    { links: [
      { href: "https://www.nowcoder.com/discuss/111", text: "字节前端一面面经" },
      { href: "https://www.nowcoder.com/discuss/222", text: "嵌入式开发记录" },
      { href: "https://www.nowcoder.com/discuss/333", text: "拼多多笔试真题" },
    ] },
    { links: [
      { href: "https://juejin.cn/post/444", text: "字节前端一面面经（转载）" },
      { href: "https://juejin.cn/post/555", text: "React Hooks 面试题整理" },
    ] },
  ]);
  const r = await toolSearchPosts("前端面经");
  const titles = r.results.map((p) => p.title);
  const noEmbed = !titles.some((t) => t.includes("嵌入式"));
  const noSeen = !titles.some((t) => t.includes("拼多多"));
  const noDupe = titles.filter((t) => t.startsWith("字节前端一面面经")).length <= 1;
  return { ok: noEmbed && noSeen && noDupe, detail: `结果:${titles.join(" | ") || "空"}` };
});

// ========== 运行 ==========
console.log("========== Agent/Harness 能力评测（Layer B，mock LLM 故障注入） ==========");
console.log("说明：LLM 决策被 mock 固定，以下全部验证 agent 机制本身，与模型水平无关\n");

const results = [];
for (const s of scenarios) {
  try {
    const r = await s.fn();
    results.push({ name: s.name, ok: !!r.ok, detail: r.detail || "" });
    console.log(`${r.ok ? "✅" : "❌"} ${s.name}${r.ok ? "" : ` → ${r.detail || ""}`}`);
  } catch (e) {
    results.push({ name: s.name, ok: false, detail: e.message.slice(0, 80) });
    console.log(`❌ ${s.name} → 异常: ${e.message.slice(0, 80)}`);
  }
}

const pass = results.filter((r) => r.ok).length;
console.log(`\n通过率: ${pass}/${results.length} = ${Math.round((pass / results.length) * 100)}%`);

if (!NO_SAVE) {
  const dir = path.join(ROOT, "benchmark", "reports");
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const report = { ts: new Date().toISOString(), layer: "B", pass, total: results.length, rate: pass / results.length, results };
  writeFileSync(path.join(dir, `agent-${ts}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(dir, "agent-latest.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`报告: benchmark/reports/agent-${ts}.json`);
}
process.exit(pass === results.length ? 0 : 1);
