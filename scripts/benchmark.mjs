// 模型基线评测（Layer A）：讲解质量 + 分类 + 检测 + 静态匹配
// 注意：本层反映「模型 + prompt」组合能力（内部仍调 LLM API），用于回归监控 prompt/模型变更，
// 不体现 harness 能力。Agent 机制本身的评测见 scripts/benchmark-agent.mjs（Layer B，mock LLM 故障注入）。
// 用法: node scripts/benchmark.mjs [--quick] [--no-save] [--judge-check]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { llmChat, extractJson, startEvalMetrics, getEvalMetrics } from "../lib/llm.mjs";
import { solveQuestion, classifyPage, detectQuestions } from "../lib/ai.mjs";
import { matchKp } from "../lib/knowledge.mjs";
import { summarizeEvalCost, formatEvalCost } from "../lib/eval-cost.mjs";
import { appendEvalSummary } from "../lib/eval-summary.mjs";
import { judgeAnswer, judgeTruthfulness, coverageRate, truthScore, TRUTH_LABEL_SCORE, TRUTH_LABEL_RANK } from "../lib/eval-scoring.mjs";
import { computeDatasetHash } from "./validate-evaldata.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
const NO_SAVE = process.argv.includes("--no-save");
const JUDGE_CHECK = process.argv.includes("--judge-check");
// 评测用临时库隔离（trace 记录不污染真实 mianshi.db 统计）
import { setupTempDb } from "../tests/helpers.mjs";
setupTempDb("bench-a");
const load = (f) => JSON.parse(readFileSync(path.join(ROOT, "benchmark", f), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 评测期 LLM 成本/延迟计数（Phase 评测 W2：本地计数器，零落盘） ----------
startEvalMetrics();

// ---------- eval_summary.csv 追加（回归对比的数据底座；共享写入模块） ----------
const NO_SUMMARY = process.argv.includes("--no-summary");
function appendSummary(fields) {
  if (NO_SUMMARY) return;
  // 兼容数组与 join 后的字符串两种调用形态
  return appendEvalSummary(Array.isArray(fields) ? fields : String(fields).split(","));
}

// ---------- 真实性标签（CRAG；共享实现见 lib/eval-scoring.mjs）----------
// 本地保留 truthAdjacent（judge-check 相邻一致性用）
function truthAdjacent(a, b) {
  if (!a || !b || TRUTH_LABEL_RANK[a] === undefined || TRUTH_LABEL_RANK[b] === undefined) return false;
  return Math.abs(TRUTH_LABEL_RANK[a] - TRUTH_LABEL_RANK[b]) <= 1;
}

// ---------- 客观判定工具 ----------
function extractCodeBlocks(md) {
  return [...md.matchAll(/```(?:js|javascript|ts|typescript)?\n([\s\S]*?)```/g)].map((m) => m[1]).filter((c) => c.trim().length > 10);
}

function runNode(code, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", code], { windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const t = setTimeout(() => { child.kill(); resolve({ ok: false, out, err: err + " [timeout]" }); }, timeoutMs);
    child.on("close", (codeNum) => { clearTimeout(t); resolve({ ok: codeNum === 0 && out.includes("PASS"), out, err }); });
  });
}

function normStdout(s) {
  return String(s || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// coverageRate 已由 lib/eval-scoring.mjs 提供（共享）

// ---------- LLM-as-Judge / 真实性判官（共享实现见 lib/eval-scoring.mjs：judgeAnswer/judgeTruthfulness/refText） ----------
// 本地保留 TRACe 四维判官（消融不涉及，仅主评测用）
async function judgeTrace(q, answer) {
  const prompt = `你是严谨的评测员。下面是一道基于给定材料的问答题（"根据下面材料回答"式）、给定材料、以及 AI 的回答。请按四个维度打分（各 0-1，可给 0.1 粒度的小数）：
- relevance 相关性：回答是否紧扣题目要求，无跑题或无关内容（0=完全跑题，1=完全相关）
- utilization 材料利用：是否正确提取并利用了给定材料中的关键信息，无编造材料之外的虚假内容（0=脱离材料/编造，1=充分准确利用）
- adherence 指令遵守：是否遵守"只依据材料回答"等约束，输出是否按要求组织（0=严重违背指令，1=完全遵守）
- completeness 完整性：是否完整覆盖题目要求的所有要点（0=大量遗漏，1=全部覆盖）
给分要严格。
题目：${q.title}
给定材料：${String(q.context || "").slice(0, 4000)}
AI 回答：${answer.slice(0, 6000)}
只输出 JSON：{"relevance":0,"utilization":0,"adherence":0,"completeness":0}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await llmChat([
        { role: "system", content: "你是严谨的评测员，只输出合法 JSON。" },
        { role: "user", content: prompt },
      ], { maxTokens: 2000, temperature: 0.2, tag: "judge" });
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);
      if (parsed && typeof parsed.relevance === "number" && typeof parsed.utilization === "number" &&
          typeof parsed.adherence === "number" && typeof parsed.completeness === "number") return parsed;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return null; // 3 次失败 → 降级
}

// 客观判定权威：code/predict 用 objective 定标签；开放题返回 null（走判官）
function objectiveTruth(q, answer, objective) {
  if (!answer || String(answer).trim().length <= 100) return { label: "missing", score: 50, source: "objective" };
  if (q.type === "code" || q.type === "predict") {
    return objective === 50
      ? { label: "correct", score: 100, source: "objective" }
      : { label: "incorrect", score: 0, source: "objective" };
  }
  return null;
}

// ---------- 单题评测 ----------
async function evalQuestion(q) {
  // solve 空响应/异常 → 重试（评测时偶发网关空响应，不能归为讲解能力问题）
  let answer = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      answer = await solveQuestion({ title: q.title, text: q.question, company: "评测", position: "前端", sourceUrl: "" });
      if (answer && answer.trim().length > 100) break;
    } catch { /* retry */ }
    if (attempt < 2) await sleep(1500);
  }

  // 客观分
  let objective = 0, detail = "";
  if (q.type === "code" || q.type === "predict") {
    const blocks = extractCodeBlocks(answer);
    let passed = false;
    for (const b of blocks) {
      if (q.type === "code") {
        const r = await runNode(`${b}\n\n${q.test}`);
        if (r.ok) { passed = true; break; }
      } else {
        // predict 通道①：跑代码块，stdout 与期望输出逐行比对（不能套用 code 的 PASS 判定）
        const r = await runNode(b);
        if (r.code === 0 && normStdout(r.out).join("\n") === normStdout(q.expected_stdout).join("\n")) {
          passed = true;
          break;
        }
      }
    }
    // predict 通道②：讲解文本明确写出期望数字序列（LLM 波动时代码块可能不完整，但结论正确也算过）
    if (!passed && q.type === "predict" && q.expected_stdout) {
      const digits = normStdout(q.expected_stdout);
      const pattern = digits.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^0-9]*");
      if (new RegExp(pattern).test(answer)) {
        passed = true;
        detail = "文本明确给出输出序列";
      }
    }
    objective = passed ? 50 : 0;
    if (!passed && !detail) detail = `代码验证失败(${blocks.length}个代码块)`;
  }
  const cov = coverageRate(answer, q.must_cover);
  if (!answer || answer.trim().length <= 100) {
    return { id: q.id, title: q.title, type: q.type, score: 0, objective: 0, covRate: 0, covHit: [], covMissing: q.must_cover || [], judge: 0, judgeOk: false, detail: "讲解生成失败(3次重试后仍为空)", answerLen: 0, truth: { label: "missing", score: 50, source: "objective" } };
  }

  // Judge 辅助分（双评平均，带重试；失败降级）
  const j1 = await judgeAnswer(q, answer);
  await sleep(150);
  const j2 = await judgeAnswer(q, answer);
  const judgeScore = (j1 && j2) ? Math.round((j1.total + j2.total) / 2) : 0;
  const judgeOk = !!(j1 && j2);

  const score = q.type === "coverage"
    ? Math.round(cov.rate * 0.6 + (judgeOk ? judgeScore * 0.4 : 0) + (judgeOk ? 0 : cov.rate * 0.4))
    : Math.round(objective + cov.rate * 0.3 + (judgeOk ? judgeScore * 0.2 : cov.rate * 0.2));

  // 真实性（CRAG）：客观判定权威；开放题（coverage）走事实核查判官
  let truth = objectiveTruth(q, answer, objective);
  if (!truth) {
    const t = await judgeTruthfulness(q, answer);
    truth = t ? { label: t.label, score: truthScore(t.label), source: "judge" } : { label: null, score: null, source: "judge-failed" };
  }

  return { id: q.id, title: q.title, type: q.type, score, objective, covRate: cov.rate, covHit: cov.hit, covMissing: (q.must_cover || []).filter((k) => !cov.hit.includes(k)), judge: judgeScore, judgeOk, detail, answerLen: answer.length, truth };
}

// ---------- TRACe 材料题评测 ----------
async function evalTraceQuestion(q) {
  const text = `根据下面材料回答问题。\n\n【材料】\n${q.context}\n\n【问题】\n${q.question}`;
  let answer = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      answer = await solveQuestion({ title: q.title, text, company: "评测", position: "前端", sourceUrl: "" });
      if (answer && answer.trim().length > 100) break;
    } catch { /* retry */ }
    if (attempt < 2) await sleep(1500);
  }
  if (!answer || answer.trim().length <= 100) {
    return { id: q.id, title: q.title, type: "trace", score: 0, trace: null, truth: { label: "missing", score: 50, source: "objective" }, detail: "讲解生成失败(3次重试后仍为空)", answerLen: 0 };
  }
  const t = await judgeTrace(q, answer);
  await sleep(150);
  const tj = await judgeTruthfulness(q, answer);
  const truth = tj ? { label: tj.label, score: truthScore(tj.label), source: "judge" } : { label: null, score: null, source: "judge-failed" };
  const score = t ? Math.round(((t.relevance + t.utilization + t.adherence + t.completeness) / 4) * 100) : 0;
  return { id: q.id, title: q.title, type: "trace", score, trace: t, truth, detail: t ? "" : "TRACe 判官失败", answerLen: answer.length };
}

// ---------- 判官金标校验（--judge-check） ----------
async function judgeTruthfulnessGold(g) {
  // 复用评测真实判官（lib/eval-scoring.mjs 的 judgeTruthfulness——含长文校准规则）：
  // 修复：此前独立实现（旧 prompt + maxTokens 200）→ 金标校验校验的不是评测实际用的判官，失去意义
  const j = await judgeTruthfulness({ title: g.question, must_cover: [] }, g.answer);
  return j ? j.label : null;
}

async function runJudgeCheck() {
  const gold = load("judge-gold.json").pairs;
  console.log(`===== 判官金标校验（${gold.length} 组，双评） =====`);
  const results = [];
  for (const g of gold) {
    const j1 = await judgeTruthfulnessGold(g);
    await sleep(150);
    const j2 = await judgeTruthfulnessGold(g);
    results.push({ id: g.id, gold: g.label, j1, j2 });
    console.log(`  ${g.id}: gold=${g.label}  judge1=${j1 ?? "失败"}  judge2=${j2 ?? "失败"}`);
  }
  let exact = 0, adjacent = 0, compared = 0, interExact = 0, interCompared = 0;
  for (const r of results) {
    for (const jl of [r.j1, r.j2]) {
      if (jl === null) continue;
      compared++;
      if (jl === r.gold) exact++;
      if (truthAdjacent(jl, r.gold)) adjacent++;
    }
    if (r.j1 !== null && r.j2 !== null) {
      interCompared++;
      if (r.j1 === r.j2) interExact++;
    }
  }
  const exactRate = compared ? Math.round((exact / compared) * 1000) / 10 : 0;
  const adjacentRate = compared ? Math.round((adjacent / compared) * 1000) / 10 : 0;
  const interRate = interCompared ? Math.round((interExact / interCompared) * 1000) / 10 : 0;
  const warning = exactRate < 70;
  console.log(`\n判官一致性: 精确一致 ${exactRate}% (${exact}/${compared}) | 相邻一致 ${adjacentRate}% (${adjacent}/${compared}) | 判官间一致 ${interRate}% (${interExact}/${interCompared})`);
  if (warning) console.log(`⚠️ 警告: 判官精确一致率 < 70%，金标校验未通过，需检查判官 prompt 或金标标注`);
  const agreement = { total: gold.length, compared, exact, adjacent, exactRate, adjacentRate, interJudgeRate: interRate, warning };
  // judge-check 也写 summary 行（mode=judge-check，composite 位置放判官 exactRate）
  const costJ = summarizeEvalCost(getEvalMetrics());
  appendSummary([
    new Date().toISOString(), "A", "judge-check", computeDatasetHash(2, load("judge-gold.json").pairs), costJ.model || "",
    Math.round(exactRate), 0, 0, 0, 0, 0, 0,
    costJ.costTokens, costJ.costUsd, costJ.p50Ms, costJ.p95Ms, "", costJ.failCount, 0,
  ].join(","));
  if (!NO_SAVE) {
    const reportsDir = path.join(ROOT, "benchmark", "reports");
    mkdirSync(reportsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
    const report = { ts: new Date().toISOString(), mode: "judge-check", judgeAgreement: agreement, details: { judgeCheck: results } };
    writeFileSync(path.join(reportsDir, `${ts}.json`), JSON.stringify(report, null, 2), "utf8");
    writeFileSync(path.join(reportsDir, "judge-check-latest.json"), JSON.stringify(report, null, 2), "utf8");
    console.log(`\n报告已保存: benchmark/reports/${ts}.json`);
  }
}

// ---------- 分类/检测/静态 ----------
async function runClassify(cases) {
  const results = [];
  for (const c of cases) {
    try {
      const r = await classifyPage({ title: c.title, text: c.text });
      results.push({ id: c.id, expected: c.expected, actual: r.type, ok: r.type === c.expected });
      await sleep(120);
    } catch { results.push({ id: c.id, expected: c.expected, actual: "error", ok: false }); }
  }
  const pass = results.filter((r) => r.ok).length;
  return { pass, total: results.length, rate: Math.round((pass / results.length) * 1000) / 10, results };
}
async function runDetect(cases) {
  const results = [];
  for (const c of cases) {
    try {
      const r = await detectQuestions({ title: c.title, text: c.text });
      results.push({ id: c.id, expected: c.expected, actual: r.hasQuestion, ok: r.hasQuestion === c.expected });
      await sleep(120);
    } catch { results.push({ id: c.id, expected: c.expected, actual: "error", ok: false }); }
  }
  const pass = results.filter((r) => r.ok).length;
  return { pass, total: results.length, rate: Math.round((pass / results.length) * 1000) / 10, results };
}
// 静态用例（Phase 评测 W1 迁移：从硬编码迁至 benchmark/static.json，来源可追溯）
function loadStaticCases() {
  try {
    const data = load("static.json");
    if (Array.isArray(data?.cases)) {
      return data.cases.map((c) => [c.text, c.expected ?? null]);
    }
  } catch { /* 迁移失败回退硬编码（不应发生） */ }
  return [
    ["事件循环与微任务", "js-event-loop"],
    ["React Hooks 原理", "rc-hooks"],
    ["原型链", "js-prototype"],
    ["Webpack 配置", "eng-build"],
    ["XSS 跨域 CORS", "br-security"],
    ["完全不相关内容", null],
  ];
}
function runStatic() {
  const results = loadStaticCases().map(([text, expected]) => {
    const actual = matchKp(text);
    // expected=null 语义："应未命中知识树点"——matchKp 未命中时兜底返回原文
    const ok = expected === null ? actual === text : actual === expected;
    return { text, expected, actual, ok };
  });
  const pass = results.filter((r) => r.ok).length;
  return { pass, total: results.length, rate: Math.round((pass / results.length) * 1000) / 10, results };
}

// ---------- 主流程 ----------
const startedAt = Date.now();
console.log("========== Mashiro 端到端评测 v3（客观判定 + 真实性 + TRACe） ==========");
console.log(`模式: ${QUICK ? "quick（2 题 + 1 材料题）" : "full"} | ${new Date().toLocaleString("zh-CN")}\n`);

// --judge-check 独立模式（最便宜：只跑判官金标校验，不跑全量评测）
if (JUDGE_CHECK) {
  await runJudgeCheck();
  process.exit(0);
}

const questions = load("questions.json").questions;
const classify = load("classify.json").cases;
const detect = load("detect.json").cases;
const evalQuestions = QUICK ? questions.filter((q) => q.type !== "trace").slice(0, 2) : questions.filter((q) => q.type !== "trace");
const traceQuestions = questions.filter((q) => q.type === "trace");
const evalTrace = QUICK ? traceQuestions.slice(0, 1) : traceQuestions;

console.log(`【1/5】讲解质量（${evalQuestions.length} 题：${evalQuestions.map((q) => q.type).join("/")}）...`);
const qResults = [];
for (const q of evalQuestions) {
  try {
    const r = await evalQuestion(q);
    qResults.push(r);
    const covNote = r.covMissing.length ? ` 缺:${r.covMissing.join("、")}` : "";
    const judgeNote = r.judgeOk ? ` judge${r.judge}` : " judge失败";
    const truthNote = r.truth?.label ? ` 真${r.truth.label}` : " 真?";
    console.log(`  ${r.objective === 50 || q.type === "coverage" ? "✅" : "❌"} ${r.id} ${r.title.slice(0, 18)}: ${r.score}分 [客观${r.objective} 覆盖${r.covRate}%${judgeNote}${truthNote}] ${r.detail}${covNote}`);
  } catch (e) {
    qResults.push({ id: q.id, title: q.title, type: q.type, score: 0, objective: 0, covRate: 0, covHit: [], covMissing: q.must_cover || [], judge: 0, judgeOk: false, truth: { label: null, score: null, source: "error" }, detail: `失败: ${e.message.slice(0, 50)}`, answerLen: 0 });
    console.log(`  ❌ ${q.id} ${q.title.slice(0, 18)}: ${e.message.slice(0, 60)}`);
  }
  await sleep(300);
}
const qScore = Math.round(qResults.reduce((s, r) => s + r.score, 0) / qResults.length);
const codePass = qResults.filter((r) => r.type !== "coverage" && r.objective === 50).length;
const codeTotal = qResults.filter((r) => r.type !== "coverage").length;
console.log(`  → 讲解均分: ${qScore}/100（客观代码/输出验证 ${codePass}/${codeTotal} 通过）\n`);

console.log(`【2/5】TRACe 材料题（${evalTrace.length} 题，根据材料回答）...`);
const traceResults = [];
for (const q of evalTrace) {
  try {
    const r = await evalTraceQuestion(q);
    traceResults.push(r);
    if (r.trace) {
      const t = r.trace;
      console.log(`  ${r.id} ${r.title.slice(0, 18)}: ${r.score}分 [rel${(t.relevance * 100).toFixed(0)} util${(t.utilization * 100).toFixed(0)} adh${(t.adherence * 100).toFixed(0)} comp${(t.completeness * 100).toFixed(0)}] 真${r.truth?.label ?? "?"} ${r.detail}`);
    } else {
      console.log(`  ❌ ${r.id} ${r.title.slice(0, 18)}: ${r.score}分 [TRACe判官失败] ${r.detail}`);
    }
  } catch (e) {
    traceResults.push({ id: q.id, title: q.title, type: "trace", score: 0, trace: null, truth: { label: null, score: null, source: "error" }, detail: `失败: ${e.message.slice(0, 50)}`, answerLen: 0 });
    console.log(`  ❌ ${q.id} ${q.title.slice(0, 18)}: ${e.message.slice(0, 60)}`);
  }
  await sleep(300);
}
const traceDims = { relevance: 0, utilization: 0, adherence: 0, completeness: 0 };
for (const d of Object.keys(traceDims)) {
  const vals = traceResults.map((r) => r.trace?.[d]).filter((v) => typeof v === "number");
  traceDims[d] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000 : 0;
}
const traceAvg = traceResults.length ? Math.round(traceResults.reduce((s, r) => s + r.score, 0) / traceResults.length) : 0;
console.log(`  → TRACe 均分: ${traceAvg}/100（relevance ${(traceDims.relevance * 100).toFixed(0)}% / utilization ${(traceDims.utilization * 100).toFixed(0)}% / adherence ${(traceDims.adherence * 100).toFixed(0)}% / completeness ${(traceDims.completeness * 100).toFixed(0)}%）\n`);

console.log(`【3/5】页面分类（${classify.length} 样本）...`);
const cRes = await runClassify(classify);
console.log(`  → 分类准确率: ${cRes.rate}% (${cRes.pass}/${cRes.total})\n`);

console.log(`【4/5】题目检测（${detect.length} 样本）...`);
const dRes = await runDetect(detect);
console.log(`  → 检测准确率: ${dRes.rate}% (${dRes.pass}/${dRes.total})\n`);

const sRes = runStatic();
console.log(`【5/5】知识点匹配（${sRes.total} 组静态断言）...`);
console.log(`  → 匹配准确率: ${sRes.rate}%\n`);

// 真实性 CRAG：correct +1 / acceptable +0.5 / missing 0 / incorrect -1，映射 0-100 取平均
const truthScores = [...qResults, ...traceResults].map((r) => r.truth?.score).filter((v) => typeof v === "number");
const truthfulness = truthScores.length ? Math.round(truthScores.reduce((a, b) => a + b, 0) / truthScores.length) : 0;
const labelCounts = { correct: 0, acceptable: 0, missing: 0, incorrect: 0 };
for (const r of [...qResults, ...traceResults]) {
  if (r.truth?.label && labelCounts[r.truth.label] !== undefined) labelCounts[r.truth.label]++;
}
console.log(`【真实性 CRAG】均分 ${truthfulness}/100（${truthScores.length} 题：correct ${labelCounts.correct} / acceptable ${labelCounts.acceptable} / missing ${labelCounts.missing} / incorrect ${labelCounts.incorrect}）\n`);

const composite = Math.round(qScore * 0.5 + cRes.rate * 0.15 + dRes.rate * 0.2 + sRes.rate * 0.15);
console.log("========== 评测结果 ==========");
console.log(`讲解质量:   ${qScore}/100（客观代码验证 ${codePass}/${codeTotal}）`);
console.log(`TRACe 材料: ${traceAvg}/100（relevance/utilization/adherence/completeness）`);
console.log(`真实性:     ${truthfulness}/100`);
console.log(`分类准确率: ${cRes.rate}%`);
console.log(`检测准确率: ${dRes.rate}%`);
console.log(`静态匹配:   ${sRes.rate}%`);
console.log(`综合评分:   ${composite}/100`);
console.log(`耗时:       ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

if (!NO_SAVE) {
  const reportsDir = path.join(ROOT, "benchmark", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  // Phase 评测 W2：成本/延迟/模型/hash/pass1/failCount（回归对比与简历数据底座）
  const cost = summarizeEvalCost(getEvalMetrics());
  const dataHash = computeDatasetHash(2, load("questions.json").questions);
  const failCount = [...qResults, ...traceResults].filter((r) => /失败/.test(String(r.detail || ""))).length;
  const pass1 = codeTotal > 0 ? Math.round((codePass / codeTotal) * 1000) / 10 : null; // code/predict 客观首次通过率
  console.log(`\n【成本/延迟】${formatEvalCost(cost)}`);
  const report = {
    // envelope（可复现性 §6.3）：model / datasetHash / node / temperature / 模式
    ts: new Date().toISOString(), mode: QUICK ? "quick" : "full", composite,
    envelope: {
      model: cost.model || null,
      datasetHash: dataHash,
      node: process.version,
      params: { judgeTemperature: 0.2, solverTemperature: 0.5 },
      mocked: false,
    },
    metrics: {
      costTokens: cost.costTokens, costUsd: cost.costUsd, calls: cost.calls,
      failCount: cost.failCount + failCount, p50Ms: cost.p50Ms, p95Ms: cost.p95Ms,
      byTag: cost.byTag, pass1,
    },
    dims: { solve: qScore, codePass: `${codePass}/${codeTotal}`, classify: cRes.rate, detect: dRes.rate, static: sRes.rate },
    truthfulness,
    trace: traceDims,
    judgeAgreement: null,
    details: { questions: qResults, trace: traceResults, classify: cRes.results, detect: dRes.results, static: sRes.results },
  };
  writeFileSync(path.join(reportsDir, `${ts}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(reportsDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
  // eval_summary.csv 追加（回归对比底座；成本 0 也如实记录）
  appendSummary([
    new Date().toISOString(), "A", QUICK ? "quick" : "full", dataHash, cost.model || "",
    composite, qScore, truthfulness, cRes.rate, dRes.rate, sRes.rate, traceAvg,
    cost.costTokens, cost.costUsd, cost.p50Ms, cost.p95Ms, pass1 ?? "", cost.failCount + failCount, 0,
  ].join(","));
  console.log(`\n报告已保存: benchmark/reports/${ts}.json`);
}
process.exit(0);
