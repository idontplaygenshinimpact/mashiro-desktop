// Agent/Harness 能力评测（Layer B）：mock LLM 故障注入，与模型水平无关
// 测的是 harness 本身：工具循环/参数校验/容错/压缩/记忆闭环/搜索过滤
// 换任何模型跑结果一致（LLM 被 mock 固定响应，验证的是 agent 机制）
// 新增能力：
//   1) 模拟面试官场景（benchmark/agent-scenarios/*.json，interviewer LLM 出题→追问→收官）
//   2) 状态式评分：goalState 校验真实 DB 状态（非 transcript），只读 imports（getPlan/loadCards/memory）
//   3) pass^k 一致性：--repeat N（默认 3），每个场景 N 次跑在独立临时库，一致率 = 通过次数/N
//   4) 失败分类（taxonomy）：premature_stop / wrong_tool / constraint_miss / state_mismatch / crash / timeout
// 用法:
//   node --experimental-test-module-mocks scripts/benchmark-agent.mjs [--no-save] [--repeat N]
// 内部子进程模式（父进程为 pass^k 每次起一个全新进程=全新临时库）:
//   node --experimental-test-module-mocks scripts/benchmark-agent.mjs --scenario <id> --result-file <path>
import { writeFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { mockLLM, mockFetchPage, setLlmResponses, setMockPages, setupTempDb, setBrowseFails, resetBrowseFails } from "../tests/helpers.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCENARIO_DIR = path.join(ROOT, "benchmark", "agent-scenarios");
const REPORT_DIR = path.join(ROOT, "benchmark", "reports");

function argValue(name, dflt = "") {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const NO_SAVE = process.argv.includes("--no-save");
const CHILD_ID = argValue("--scenario");          // 子进程模式：只跑单个场景
const RESULT_FILE = argValue("--result-file");    // 子进程模式：结果写此文件
const REPEAT = Math.max(1, parseInt(argValue("--repeat", "3"), 10) || 3);
const CHILD_TIMEOUT_MS = 60000;                   // 单场景子进程超时（分类为 timeout）
const SCENARIO_TIMEOUT_MS = 50000;                // 场景内部兜底超时（略小于子进程）

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

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

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

/** 场景内兜底超时（防单个场景挂死；真正的 timeout 分类由父进程 kill 触发） */
async function withTimeout(fn, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`场景超时(>${ms}ms)`)), ms); });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ========== 场景注册 ==========
const legacyScenarios = [];
function scenario(name, fn, meta = {}) {
  legacyScenarios.push({ id: meta.id || name, name, fn, kind: "legacy", expectedTools: meta.expectedTools || [], goalState: meta.goalState || null });
}

/** 清空所有表 + 内存镜像（含 trace_tools，供 taxonomy 统计本场景工具调用） */
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
  resetBrowseFails(); // 清 browse 故障注入（每个场景独立）
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
}, { expectedTools: ["plan_task"] });

scenario("参数校验：LLM 传缺参 → validateArgs 拦截，不执行工具", async () => {
  await resetState();
  setLlmResponses(
    'TOOLCALL:{"name":"solve_question","arguments":"{}"}',
    "我重新组织回答。"
  );
  await chatWithAgent("讲讲事件循环");
  const tools = getRecentTools(10);
  const bad = tools.find((t) => t.tool_name === "solve_question");
  return { ok: !!bad && !bad.ok && !!bad.error, detail: `拦截原因:${bad?.error?.slice(0, 30)}` };
}, { expectedTools: ["solve_question"] });

scenario("未知工具：LLM 幻觉工具名 → 报错不崩溃", async () => {
  await resetState();
  setLlmResponses('TOOLCALL:{"name":"不存在的工具","arguments":"{}"}', "好的。");
  const r = await chatWithAgent("x");
  return { ok: r.reply.length > 0, detail: `回复:${r.reply.slice(0, 10)}` };
}, { expectedTools: ["不存在的工具"] });

scenario("记忆写入：remember 工具 → 关注点持久化", async () => {
  await resetState();
  setLlmResponses('TOOLCALL:{"name":"remember","arguments":"{\\"topics\\":[\\"React\\"]}"}', "记住啦。");
  await chatWithAgent("关注 React");
  return { ok: memory.getInterests().includes("React"), detail: `interests:${memory.getInterests().join(",")}` };
}, { expectedTools: ["remember"] });

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

scenario("语音稿分离：【语音】标记从回复中剥离（voice 恒空）", async () => {
  await resetState();
  setLlmResponses("结论在这里【语音】很简单哦~");
  const r = await chatWithAgent("hi");
  return { ok: r.voice === "" && !r.reply.includes("【语音】") && r.reply.includes("结论在这里"), detail: `reply:${r.reply} voice:${r.voice}` };
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
}, { expectedTools: ["record_interview_topics"] });

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

// ========== 场景 14-19：浏览器自动化（browse_* 工具）故障注入 ==========
// 覆盖 agent 对浏览工具"成功回填 / 失败回填"的处理：错误必须回填给模型且不崩溃
scenario("browse_open 成功：打开页面 → 回填标题/URL", async () => {
  await resetState();
  resetBrowseFails();
  setLlmResponses(
    'TOOLCALL:{"name":"browse_open","arguments":"{\\"url\\":\\"https://example.com/post/1\\"}"}',
    "页面已打开，标题是 mock浏览页。"
  );
  const r = await autoApproveDuring(() => chatWithAgent("打开这个页面看看"));
  const tools = getRecentTools(10);
  const t = tools.find((x) => x.tool_name === "browse_open");
  return { ok: !!t && t.ok && r.reply.includes("mock浏览页"), detail: `工具ok:${!!t?.ok} 回复:${r.reply.slice(0, 16)}` };
}, { expectedTools: ["browse_open"] });

scenario("browse_open SSRF/超时拦截：返回错误不崩溃", async () => {
  await resetState();
  setBrowseFails({ open: true });
  setLlmResponses(
    'TOOLCALL:{"name":"browse_open","arguments":"{\\"url\\":\\"http://127.0.0.1/internal\\"}"}',
    "这个页面打不开，我换个方式。"
  );
  const r = await autoApproveDuring(() => chatWithAgent("打开这个内网页面"));
  const tools = getRecentTools(10);
  const t = tools.find((x) => x.tool_name === "browse_open");
  return { ok: !!t && !t.ok && !!t.error && r.reply.length > 0, detail: `拦截:${!!t?.error} 回复:${r.reply.slice(0, 12)}` };
}, { expectedTools: ["browse_open"] });

scenario("browse_click 元素缺失：错误回填不崩溃", async () => {
  await resetState();
  setBrowseFails({ click: true });
  setLlmResponses(
    'TOOLCALL:{"name":"browse_click","arguments":"{\\"url\\":\\"https://example.com\\",\\"target\\":\\"#login-btn\\"}"}',
    "没找到这个按钮，我看看别的。"
  );
  const r = await autoApproveDuring(() => chatWithAgent("点一下登录按钮"));
  const tools = getRecentTools(10);
  const t = tools.find((x) => x.tool_name === "browse_click");
  return { ok: !!t && !t.ok && !!t.error && r.reply.length > 0, detail: `错误:${t?.error?.slice(0, 20)}` };
}, { expectedTools: ["browse_click"] });

scenario("browse_type 输入+回车：成功回填", async () => {
  await resetState();
  resetBrowseFails();
  setLlmResponses(
    'TOOLCALL:{"name":"browse_type","arguments":"{\\"url\\":\\"https://example.com/search\\",\\"selector\\":\\"input\\",\\"text\\":\\"React 面经\\"}"}',
    "已输入并提交搜索。"
  );
  const r = await autoApproveDuring(() => chatWithAgent("在搜索框输入 React 面经"));
  const tools = getRecentTools(10);
  const t = tools.find((x) => x.tool_name === "browse_type");
  return { ok: !!t && t.ok && r.reply.length > 0, detail: `工具ok:${!!t?.ok} 回复:${r.reply.slice(0, 12)}` };
}, { expectedTools: ["browse_type"] });

scenario("browse_screenshot 失败：错误回填不崩溃", async () => {
  await resetState();
  setBrowseFails({ screenshot: true });
  setLlmResponses(
    'TOOLCALL:{"name":"browse_screenshot","arguments":"{\\"url\\":\\"https://example.com\\"}"}',
    "截图失败了，没关系。"
  );
  const r = await autoApproveDuring(() => chatWithAgent("截个图看看"));
  const tools = getRecentTools(10);
  const t = tools.find((x) => x.tool_name === "browse_screenshot");
  return { ok: !!t && !t.ok && !!t.error && r.reply.length > 0, detail: `错误:${t?.error?.slice(0, 20)}` };
}, { expectedTools: ["browse_screenshot"] });

scenario("browse_fetch 抓取失败：错误回填不崩溃", async () => {
  await resetState();
  setBrowseFails({ fetch: true });
  setLlmResponses(
    'TOOLCALL:{"name":"browse_fetch","arguments":"{\\"url\\":\\"https://example.com/article/2\\"}"}',
    "页面抓取失败，我换个页面。"
  );
  const r = await autoApproveDuring(() => chatWithAgent("抓取这篇文章内容"));
  const tools = getRecentTools(10);
  const t = tools.find((x) => x.tool_name === "browse_fetch");
  return { ok: !!t && !t.ok && !!t.error && r.reply.length > 0, detail: `错误:${t?.error?.slice(0, 20)}` };
}, { expectedTools: ["browse_fetch"] });

// ========== 状态式评分（goalState → 真实 DB 状态，只读 imports） ==========
// goalState 支持的键（均为只读查询，不改状态）：
//   study_plan_items: [{topic, level?, reviewed?, done?, fromInterview?}]  — 必须存在匹配条目
//   review_cards:     [{topic, question?, source?}]                        — 必须存在匹配复习卡
//   weak_points:      [{topic}]                                           — 薄弱点必须存在
//   mastered_points:  [{topic}]                                           — 已掌握必须存在
//   interview_history: {min?, position?, role?}                           — 历史面试记录
//   interview:        {active?, position?, question?}                     — 进行中的面试会话
function checkGoalState(goal) {
  const fails = [];
  const marks = [];
  for (const c of goal.study_plan_items || []) {
    const hit = getPlan().items.find((i) =>
      (!c.topic || i.topic === c.topic) &&
      (c.level === undefined || i.level === c.level) &&
      (c.reviewed === undefined || !!i.reviewed === !!c.reviewed) &&
      (c.done === undefined || !!i.done === !!c.done) &&
      (c.fromInterview === undefined || !!i.fromInterview === !!c.fromInterview));
    marks.push(`清单:${c.topic}${hit ? "✓" : "✗"}`);
    if (!hit) fails.push(`学习清单缺条目 ${JSON.stringify(c)}`);
  }
  for (const c of goal.review_cards || []) {
    const hit = review.loadCards().cards.find((cd) =>
      (!c.topic || cd.topic === c.topic) &&
      (c.question === undefined || cd.question === c.question) &&
      (c.source === undefined || cd.source === c.source));
    marks.push(`复习卡:${c.topic}${hit ? "✓" : "✗"}`);
    if (!hit) fails.push(`复习卡缺失 ${JSON.stringify(c)}`);
  }
  for (const c of goal.weak_points || []) {
    const hit = memory.getWeakPoints().some((w) => w.topic === c.topic);
    marks.push(`薄弱点:${c.topic}${hit ? "✓" : "✗"}`);
    if (!hit) fails.push(`薄弱点缺失 ${c.topic}`);
  }
  for (const c of goal.mastered_points || []) {
    const hit = memory.getMastered().some((m) => m.topic === c.topic);
    marks.push(`已掌握:${c.topic}${hit ? "✓" : "✗"}`);
    if (!hit) fails.push(`已掌握缺失 ${c.topic}`);
  }
  const ih = goal.interview_history;
  if (ih) {
    const hist = memory.getInterviewHistory();
    let hit = true;
    if (ih.min !== undefined && hist.length < ih.min) { hit = false; fails.push(`面试历史不足 ${ih.min}（实际 ${hist.length}）`); }
    if (ih.position && !hist.some((h) => h.position === ih.position)) { hit = false; fails.push(`面试历史缺 position=${ih.position}`); }
    if (ih.role && !hist.some((h) => h.role === ih.role)) { hit = false; fails.push(`面试历史缺 role=${ih.role}`); }
    marks.push(`面试历史${hit ? "✓" : "✗"}`);
  }
  const iv = goal.interview;
  if (iv) {
    const s = memory.getInterview();
    let hit = true;
    if (iv.active === true && !s) { hit = false; fails.push("面试会话未进行中"); }
    if (iv.active === false && s) { hit = false; fails.push("面试会话未结束"); }
    if (iv.question && (!s || s.current?.question !== iv.question)) { hit = false; fails.push(`面试当前题不符（期望 ${iv.question}）`); }
    if (iv.position && (!s || s.position !== iv.position)) { hit = false; fails.push(`面试岗位不符（期望 ${iv.position}）`); }
    marks.push(`面试会话${hit ? "✓" : "✗"}`);
  }
  return { ok: fails.length === 0, detail: marks.join(" ") || "（无状态断言）", failures: fails };
}

// ========== 模拟面试官场景（从 JSON 加载） ==========
function loadInterviewScenarios() {
  const files = [];
  try {
    for (const f of readdirSync(SCENARIO_DIR)) if (f.endsWith(".json")) files.push(f);
  } catch { /* 目录不存在则无 JSON 场景 */ }
  files.sort();
  const list = [];
  for (const f of files) {
    try {
      const json = JSON.parse(readFileSync(path.join(SCENARIO_DIR, f), "utf8"));
      if (!json.id || !Array.isArray(json.turns)) continue;
      list.push(buildInterviewScenario(json));
    } catch (e) {
      console.log(`[bench] 场景文件解析失败 ${f}: ${e.message}`);
    }
  }
  return list;
}

function buildInterviewScenario(json) {
  const expectedTools = [...new Set((json.turns || []).flatMap((t) => t.expectedToolCalls || []))];
  const fn = async () => {
    const perTurn = [];
    const replies = [];
    for (const turn of json.turns || []) {
      const before = getRecentTools(5000).length;
      const responses = Array.isArray(turn.interviewerResponse) ? turn.interviewerResponse : [turn.interviewerResponse];
      setLlmResponses(...responses);
      const r = await autoApproveDuring(() => chatWithAgent(turn.userMessage || ""));
      replies.push(r?.reply || "");
      await sleep(5); // 冲掉 fire-and-forget 的异步写卡/写库微任务
      const afterTools = getRecentTools(5000);
      const newTools = afterTools.slice(0, Math.max(0, afterTools.length - before));
      const called = [...new Set(newTools.map((t) => t.tool_name))];
      const missing = (turn.expectedToolCalls || []).filter((t) => !called.includes(t));
      let stateFails = [];
      if (turn.expectedStateAfter) {
        const gs = checkGoalState(turn.expectedStateAfter);
        if (!gs.ok) stateFails = gs.failures;
      }
      perTurn.push({ turn: (turn.userMessage || "").slice(0, 16), called, missing, stateFails });
    }
    const ok = perTurn.every((p) => p.missing.length === 0 && p.stateFails.length === 0);
    const detail = perTurn.map((p) =>
      (p.missing.length ? `缺工具:${p.missing.join(",")}` : `工具:${p.called.join(",") || "无"}`) +
      (p.stateFails.length ? `[状态:${p.stateFails.join(";")}]` : "")
    ).join(" | ");
    return { ok, detail, reply: replies.join(" → ") };
  };
  return { id: json.id, name: json.name, kind: json.kind || "interviewer", fn, expectedTools, goalState: json.goalState || null };
}

// ========== 失败分类（rule-based taxonomy） ==========
// 顺序即优先级：crash > timeout > premature_stop > wrong_tool > constraint_miss > state_mismatch
function classifyRun(rec) {
  if (rec.crashed) return "crash";
  if (rec.timedOut) return "timeout";
  if (rec.ok) return null;
  const expected = rec.expectedTools || [];
  if (expected.length) {
    const called = rec.toolsCalled || [];
    if (called.length === 0) return "premature_stop";
    if (!expected.some((t) => called.includes(t))) return "wrong_tool";
    if (rec.toolErrors && rec.toolErrors.length) return "constraint_miss";
    return "state_mismatch";
  }
  if (!rec.reply) return "premature_stop";
  return "state_mismatch";
}

// ========== 单场景执行（统一：resetState → fn → 工具trace → goalState → taxonomy） ==========
async function runScenarioRecord(sc) {
  const t0 = Date.now();
  await resetState();
  let result;
  try {
    result = await withTimeout(sc.fn, SCENARIO_TIMEOUT_MS);
  } catch (e) {
    result = { ok: false, detail: `异常: ${String(e?.message || e).slice(0, 120)}`, __crash: true };
  }
  const tools = getRecentTools(5000);
  const toolsCalled = [...new Set(tools.map((t) => t.tool_name))];
  const toolErrors = [...new Set(tools.filter((t) => !t.ok).map((t) => t.tool_name))];
  const state = sc.goalState ? checkGoalState(sc.goalState) : { ok: true, detail: "", failures: [] };
  const ok = !!result?.ok && state.ok;
  const reply = result?.reply || "";
  const record = {
    id: sc.id, name: sc.name, kind: sc.kind,
    ok, detail: result?.detail || "",
    stateDetail: state.detail,
    toolsCalled, toolErrors,
    crashed: !!result?.__crash, timedOut: false,
    reply,
    ms: Date.now() - t0,
  };
  record.taxonomy = classifyRun({ ...record, expectedTools: sc.expectedTools });
  return record;
}

// ========== 子进程模式：跑单个场景 → 结果写 --result-file（父进程汇总 pass^k） ==========
async function childMode() {
  const all = [...legacyScenarios, ...loadInterviewScenarios()];
  const sc = all.find((s) => s.id === CHILD_ID);
  if (!sc) {
    writeFileSync(RESULT_FILE, JSON.stringify({ id: CHILD_ID, ok: false, crashed: true, detail: `未知场景: ${CHILD_ID}` }), "utf8");
    process.exit(1);
  }
  const rec = await runScenarioRecord(sc);
  // 仅回传结构化结果（父进程据此做 taxonomy/一致性），不落地报告
  writeFileSync(RESULT_FILE, JSON.stringify(rec), "utf8");
  process.exit(0);
}

// ========== 父进程：pass^k 一致性（每场景 N 次独立临时库子进程） ==========
function runChild(scenarioId) {
  return new Promise((resolve) => {
    const resultFile = path.join(tmpdir(), `bench-agent-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.json`);
    const child = spawn(
      process.execPath,
      ["--experimental-test-module-mocks", SCRIPT_PATH, "--scenario", scenarioId, "--result-file", resultFile],
      { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += String(d); });
    const cleanup = () => { try { rmSync(resultFile, { force: true }); } catch { /* ignore */ } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      cleanup();
      resolve({ id: scenarioId, ok: false, timedOut: true, detail: `超时(>${CHILD_TIMEOUT_MS / 1000}s)`, crashed: false, toolsCalled: [], toolErrors: [], reply: "" });
    }, CHILD_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      let rec = null;
      try { rec = JSON.parse(readFileSync(resultFile, "utf8")); } catch { /* ignore */ }
      cleanup();
      if (rec) resolve(rec);
      else resolve({ id: scenarioId, ok: false, crashed: true, detail: `子进程异常退出(code=${code}): ${stderr.slice(0, 200)}`, timedOut: false, toolsCalled: [], toolErrors: [], reply: "" });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanup();
      resolve({ id: scenarioId, ok: false, crashed: true, detail: `子进程启动失败: ${e.message}`, timedOut: false, toolsCalled: [], toolErrors: [], reply: "" });
    });
  });
}

function aggregateScenario(sc, runs) {
  const passN = runs.filter((r) => r.ok).length;
  const pass1 = runs[0]?.ok ?? false;
  // 每个场景取首次失败运行的 taxonomy（全过则 null）
  const firstFail = runs.find((r) => !r.ok);
  return {
    id: sc.id, name: sc.name, kind: sc.kind,
    pass1, passN, consistent: runs.length ? passN / runs.length : 0,
    taxonomy: firstFail ? (firstFail.taxonomy || "state_mismatch") : null,
    detail: runs[0]?.detail || "",
    stateDetail: runs[0]?.stateDetail || "",
    runs: runs.map((r) => ({ ok: r.ok, taxonomy: r.taxonomy || null, detail: r.detail, ms: r.ms })),
  };
}

// ========== 主流程 ==========
if (CHILD_ID) {
  await childMode();
} else {
  const scenarios = [...legacyScenarios, ...loadInterviewScenarios()];
  const interviewerScenarios = scenarios.filter((s) => s.kind === "interviewer");

  console.log("========== Agent/Harness 能力评测（Layer B，mock LLM 故障注入） ==========");
  console.log("说明：LLM 决策被 mock 固定，以下全部验证 agent 机制本身，与模型水平无关");
  console.log(`一致性：每场景跑 ${REPEAT} 次（各自独立临时库），pass1=首次，pass^${REPEAT}=通过次数，一致率=pass^${REPEAT}/${REPEAT}\n`);

  const agg = [];
  for (const sc of scenarios) {
    const runs = await Promise.all(Array.from({ length: REPEAT }, () => runChild(sc.id)));
    agg.push(aggregateScenario(sc, runs));
  }

  // 汇总
  const total = agg.length;
  const pass1Total = agg.filter((a) => a.pass1).length;
  const fullyConsistent = agg.filter((a) => a.consistent === 1).length;

  // 失败分类汇总（含所有失败运行）
  const taxonomy = { premature_stop: 0, wrong_tool: 0, constraint_miss: 0, state_mismatch: 0, crash: 0, timeout: 0 };
  for (const a of agg) {
    for (const r of a.runs) {
      if (!r.ok) taxonomy[r.taxonomy || "state_mismatch"] = (taxonomy[r.taxonomy || "state_mismatch"] || 0) + 1;
    }
  }

  console.log("[场景]");
  for (const a of agg) {
    const tag = a.pass1 ? "✅" : "❌";
    const consist = a.consistent === 1 ? "一致" : `不一致(${a.passN}/${REPEAT})`;
    console.log(`  ${tag} ${a.name}`);
    console.log(`      pass1=${a.pass1} pass^${REPEAT}=${a.passN}/${REPEAT} ${consist}${a.taxonomy ? ` 分类:${a.taxonomy}` : ""}`);
    if (a.detail) console.log(`      ${a.detail}`);
  }

  console.log("\n[模拟面试官场景]");
  for (const a of agg.filter((x) => x.kind === "interviewer")) {
    console.log(`  ${a.pass1 ? "✅" : "❌"} ${a.name} → ${a.detail || ""}${a.stateDetail ? ` 状态:${a.stateDetail}` : ""}`);
  }

  console.log("\n[失败分类]");
  console.log(`  ${Object.entries(taxonomy).map(([k, v]) => `${k}:${v}`).join("  ")}`);

  console.log(`\n通过率: ${pass1Total}/${total} = ${Math.round((pass1Total / total) * 100)}%（首次通过口径）`);
  console.log(`一致率: ${fullyConsistent}/${total} 场景 ${REPEAT} 次全过`);

  if (!NO_SAVE) {
    mkdirSync(REPORT_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const report = {
      ts: new Date().toISOString(),
      layer: "B",
      repeat: REPEAT,
      pass: pass1Total, total, rate: pass1Total / total,
      consistency: {
        fullyConsistent, total,
        scenarios: agg.map((a) => ({ id: a.id, name: a.name, pass1: a.pass1, passN: a.passN, consistent: a.consistent })),
      },
      failureTaxonomy: taxonomy,
      interviewer: {
        pass: interviewerScenarios.filter((s) => agg.find((a) => a.id === s.id)?.pass1).length,
        total: interviewerScenarios.length,
        scenarios: agg.filter((a) => a.kind === "interviewer").map((a) => ({ id: a.id, name: a.name, ok: a.pass1, detail: a.detail, stateDetail: a.stateDetail })),
      },
      results: agg.map((a) => ({ id: a.id, name: a.name, kind: a.kind, pass1: a.pass1, passN: a.passN, consistent: a.consistent, taxonomy: a.taxonomy, detail: a.detail, stateDetail: a.stateDetail })),
    };
    writeFileSync(path.join(REPORT_DIR, `agent-${ts}.json`), JSON.stringify(report, null, 2), "utf8");
    writeFileSync(path.join(REPORT_DIR, "agent-latest.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`报告: benchmark/reports/agent-${ts}.json`);
  }
  process.exit(pass1Total === total ? 0 : 1);
}
