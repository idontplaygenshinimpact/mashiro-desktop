// 消融基线 A/B（Phase 评测 W3 §5：诚实版——prompt 工程消融，非 RAG）
// 基线 A：裸 prompt——一句话"讲一讲这道题" + 题目（无系统人格、无结构模板、无 sanitize/来源约束）
// 全链路 B：现有 solveQuestion（lib/ai.mjs：career 人格化 + 结论/原理/实现/边界结构模板 + UNTRUSTED 声明）
// 同题 A/B 随机顺序跑（固定 seed 可复现，消除判官顺序偏差）；各用共享评分栈
// （Judge 双评 + CRAG 事实判官 + must_cover 覆盖度，与 benchmark.mjs 同口径）
// 用法: node scripts/bench-ablation.mjs [--sample N] [--seed S] [--no-save]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { llmChat, getReplyText, startEvalMetrics, getEvalMetrics } from "../lib/llm.mjs";
import { solveQuestion } from "../lib/ai.mjs";
import { judgeAnswer, judgeTruthfulness, coverageRate, truthScore } from "../lib/eval-scoring.mjs";
import { summarizeEvalCost, formatEvalCost } from "../lib/eval-cost.mjs";
import { appendEvalSummary } from "../lib/eval-summary.mjs";
import { computeDatasetHash } from "./validate-evaldata.mjs";
import { setupTempDb } from "../tests/helpers.mjs";
setupTempDb("bench-ablation");

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const NO_SAVE = process.argv.includes("--no-save");
function argValue(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? Number(process.argv[i + 1]) || dflt : dflt;
}
const SAMPLE = argValue("--sample", 20);
const SEED = argValue("--seed", 42);
const load = (f) => JSON.parse(readFileSync(path.join(ROOT, "benchmark", f), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 固定 seed 的洗牌（可复现的随机顺序，消除判官顺序偏差） ----------
function seededShuffle(arr, seed) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- 两个 solver ----------
/** 基线 A：裸 prompt（无结构模板/无人格/无约束） */
async function solveBare(q) {
  const data = await llmChat([
    { role: "system", content: "你是一个面试辅导助手。" },
    { role: "user", content: `讲一讲这道题：${q.question}` },
  ], { maxTokens: 8000, temperature: 0.5, tag: "solver" });
  return getReplyText(data);
}
/** 全链路 B：现有生产讲解链路 */
function solveFull(q) {
  return solveQuestion({ title: q.title, text: q.question, company: "评测", position: "前端", sourceUrl: "" });
}

// ---------- 评分（与主评测同口径：Judge 双评 + CRAG + must_cover） ----------
async function scoreQuestion(q, answer) {
  const j1 = await judgeAnswer(q, answer);
  const j2 = await judgeAnswer(q, answer);
  const judge = j1 && j2 ? Math.round((j1.total + j2.total) / 2) : null;
  const t = await judgeTruthfulness(q, answer);
  const truth = t ? { label: t.label, score: truthScore(t.label) } : null;
  const cov = coverageRate(answer, q.must_cover || []);
  return { judge, truth, coverRate: cov.rate, answerLen: String(answer || "").length };
}

const startedAt = Date.now();
startEvalMetrics();
console.log("========== 消融基线 A/B（prompt 工程消融） ==========");
console.log(`样本 ${SAMPLE} 题（seed=${SEED}）| A=裸 prompt（无模板） vs B=全链路 solveQuestion`);

const questions = load("questions.json").questions.filter((q) => q.type !== "trace");
const picked = questions.slice(0, SAMPLE);
const datasetHash = computeDatasetHash(2, load("questions.json").questions);

// 洗牌后按顺序跑：[(题, 变体A), (题, 变体B), ...] 交错（同题不紧邻也可，随机化即可）
const jobs = picked.flatMap((q) => [
  { q, variant: "A", run: () => solveBare(q) },
  { q, variant: "B", run: () => solveFull(q) },
]);
const results = {};
for (const job of seededShuffle(jobs, SEED)) {
  const key = `${job.variant}|${job.q.id}`;
  try {
    const answer = await job.run();
    results[key] = await scoreQuestion(job.q, answer);
    const s = results[key];
    console.log(`  ${job.variant} ${job.q.id} ${job.q.title.slice(0, 16)}: judge${s.judge ?? "-"} 真${s.truth?.label ?? "?"} 覆盖${s.coverRate}% ${String(s.answerLen)}字`);
  } catch (e) {
    results[key] = { judge: null, truth: null, coverRate: 0, answerLen: 0, error: String(e?.message || e).slice(0, 80) };
    console.log(`  ❌ ${job.variant} ${job.q.id}: ${String(e?.message || e).slice(0, 60)}`);
  }
  await sleep(300);
}

// ---------- 汇总 ----------
function summarize(variant) {
  const rs = picked.map((q) => results[`${variant}|${q.id}`]).filter(Boolean);
  const judges = rs.map((r) => r.judge).filter((v) => typeof v === "number");
  const truths = rs.map((r) => r.truth?.score).filter((v) => typeof v === "number");
  const covers = rs.map((r) => r.coverRate).filter((v) => typeof v === "number");
  const fails = rs.filter((r) => r.error || r.answerLen === 0).length;
  return {
    n: rs.length,
    solve: judges.length ? Math.round(judges.reduce((a, b) => a + b, 0) / judges.length) : null,
    truth: truths.length ? Math.round(truths.reduce((a, b) => a + b, 0) / truths.length) : null,
    cover: covers.length ? Math.round(covers.reduce((a, b) => a + b, 0) / covers.length) : null,
    judgeOk: judges.length,
    fails,
  };
}
const A = summarize("A");
const B = summarize("B");
const delta = {
  solve: A.solve !== null && B.solve !== null ? B.solve - A.solve : null,
  truth: A.truth !== null && B.truth !== null ? B.truth - A.truth : null,
  cover: A.cover !== null && B.cover !== null ? B.cover - A.cover : null,
};
const cost = summarizeEvalCost(getEvalMetrics());
const pctDelta = (d, base) => (d === null || !base ? null : Math.round((d / base) * 100));

console.log("\n========== 消融结果 ==========");
console.log(`A 裸 prompt:  judge均分 ${A.solve ?? "-"} · CRAG ${A.truth ?? "-"} · 覆盖 ${A.cover ?? "-"}%（${A.judgeOk}/${A.n} 判官成功）`);
console.log(`B 全链路:    judge均分 ${B.solve ?? "-"} · CRAG ${B.truth ?? "-"} · 覆盖 ${B.cover ?? "-"}%（${B.judgeOk}/${B.n} 判官成功）`);
if (delta.solve !== null) console.log(`Δ solve: ${delta.solve > 0 ? "+" : ""}${delta.solve}pt（${pctDelta(delta.solve, A.solve)}%）`);
if (delta.truth !== null) console.log(`Δ truth: ${delta.truth > 0 ? "+" : ""}${delta.truth}pt（${pctDelta(delta.truth, A.truth)}%）`);
if (delta.cover !== null) console.log(`Δ cover: ${delta.cover > 0 ? "+" : ""}${delta.cover}pt`);
console.log(`\n【成本/延迟】${formatEvalCost(cost)}`);

const summaryLine = A.solve !== null && B.solve !== null
  ? `全链路 vs 裸 prompt：讲解均分 ${A.solve}→${B.solve}（${pctDelta(delta.solve, A.solve)}%），CRAG correct 均分 ${A.truth}→${B.truth}，覆盖度 ${A.cover}→${B.cover}（实测，sample=${SAMPLE}）`
  : `消融未产出完整数值（sample=${SAMPLE}，判官失败 ${A.n - A.judgeOk + B.n - B.judgeOk} 题）——如实标注，不预填`;
console.log(`\n${summaryLine}`);

if (!NO_SAVE) {
  const reportsDir = path.join(ROOT, "benchmark", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const report = {
    ts: new Date().toISOString(),
    mode: "ablation",
    sample: SAMPLE, seed: SEED,
    datasetHash,
    envelope: { model: cost.model || null, node: process.version, mocked: false, params: { solverTemp: 0.5, judgeTemp: 0.2 } },
    a: A, b: B, delta,
    cost: { tokens: cost.costTokens, usd: cost.costUsd, calls: cost.calls, failCount: cost.failCount, p50Ms: cost.p50Ms, p95Ms: cost.p95Ms, byTag: cost.byTag },
    summary: summaryLine,
    details: results,
  };
  writeFileSync(path.join(reportsDir, `ablation-${ts}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(reportsDir, "ablation-latest.json"), JSON.stringify(report, null, 2), "utf8");
  // summary.csv 行（mode=ablation，composite 位置放 Δsolve）
  appendEvalSummary([
    new Date().toISOString(), "A", "ablation", datasetHash, cost.model || "",
    delta.solve ?? "", B.solve ?? "", B.truth ?? "", 0, 0, 0, 0,
    cost.costTokens, cost.costUsd, cost.p50Ms, cost.p95Ms, "", cost.failCount, 0,
  ]);
  console.log(`\n报告已保存: benchmark/reports/ablation-${ts}.json`);
}
process.exit(0);