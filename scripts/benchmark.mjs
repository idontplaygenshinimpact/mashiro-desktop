// 模型基线评测（Layer A）：讲解质量 + 分类 + 检测 + 静态匹配
// 注意：本层反映「模型 + prompt」组合能力（内部仍调 LLM API），用于回归监控 prompt/模型变更，
// 不体现 harness 能力。Agent 机制本身的评测见 scripts/benchmark-agent.mjs（Layer B，mock LLM 故障注入）。
// 用法: node scripts/benchmark.mjs [--quick] [--no-save]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { llmChat, extractJson } from "../lib/llm.mjs";
import { solveQuestion, classifyPage, detectQuestions } from "../lib/ai.mjs";
import { matchKp } from "../lib/knowledge.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUICK = process.argv.includes("--quick");
const NO_SAVE = process.argv.includes("--no-save");
// 评测用临时库隔离（trace 记录不污染真实 mianshi.db 统计）
import { setupTempDb } from "../tests/helpers.mjs";
setupTempDb("bench-a");
const load = (f) => JSON.parse(readFileSync(path.join(ROOT, "benchmark", f), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function coverageRate(text, mustCover) {
  const t = String(text || "").toLowerCase();
  const hit = (mustCover || []).filter((k) => t.includes(String(k).toLowerCase()));
  return { hit, rate: (mustCover || []).length ? Math.round((hit.length / mustCover.length) * 100) : 0 };
}

// ---------- LLM-as-Judge（辅助分，带重试+降级：偶发网关空响应不影响评测） ----------
async function judgeAnswer(q, answer) {
  const prompt = `你是严格的前端面试官评委。下面是一道面试题和 AI 的讲解，请按四维打分（各 0-25）：
- conclusion 结论：是否先给出清晰正确的结论
- principle 原理：是否准确有深度
- implementation 实现JS：代码是否正确可运行
- boundary 边界：是否覆盖边界情况
给分要严格：结论错误 conclusion≤8；代码有明显错误 implementation≤8。
题目：${q.title}
必考要点：${(q.must_cover || []).join("、")}
讲解：${answer.slice(0, 6000)}
只输出 JSON：{"conclusion":0,"principle":0,"implementation":0,"boundary":0,"total":0}，total=四维之和。`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await llmChat([
        { role: "system", content: "你是严格的前端面试官评委，只输出合法 JSON。" },
        { role: "user", content: prompt },
      ], { maxTokens: 500, temperature: 0.2 });
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);
      if (parsed && typeof parsed.total === "number") return parsed;
      // 兜底：llm.mjs 层已对空响应重试；这里再补 2 次短退避
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return null; // 3 次失败 → 降级（评分时按无 judge 处理）
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
    return { id: q.id, title: q.title, type: q.type, score: 0, objective: 0, covRate: 0, covHit: [], covMissing: q.must_cover || [], judge: 0, judgeOk: false, detail: "讲解生成失败(3次重试后仍为空)", answerLen: 0 };
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

  return { id: q.id, title: q.title, type: q.type, score, objective, covRate: cov.rate, covHit: cov.hit, covMissing: (q.must_cover || []).filter((k) => !cov.hit.includes(k)), judge: judgeScore, judgeOk, detail, answerLen: answer.length };
}

// ---------- 分类/检测/静态 ----------
async function runClassify(cases) {
  const results = [];
  for (const c of cases) {
    try {
      const r = await classifyPage({ title: c.title, text: c.text });
      results.push({ id: c.id, expected: c.expected, actual: r.type, ok: r.type === c.expected });
      await sleep(120);
    } catch (e) { results.push({ id: c.id, expected: c.expected, actual: "error", ok: false }); }
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
    } catch (e) { results.push({ id: c.id, expected: c.expected, actual: "error", ok: false }); }
  }
  const pass = results.filter((r) => r.ok).length;
  return { pass, total: results.length, rate: Math.round((pass / results.length) * 1000) / 10, results };
}
const STATIC_CASES = [
  ["事件循环与微任务", "js-event-loop"],
  ["React Hooks 原理", "rc-hooks"],
  ["原型链", "js-prototype"],
  ["Webpack 配置", "eng-build"],
  ["XSS 跨域 CORS", "br-security"],
  ["完全不相关内容", null],
];
function runStatic() {
  const results = STATIC_CASES.map(([text, expected]) => {
    const actual = matchKp(text);
    return { text, expected, actual, ok: actual === expected };
  });
  const pass = results.filter((r) => r.ok).length;
  return { pass, total: results.length, rate: Math.round((pass / results.length) * 1000) / 10, results };
}

// ---------- 主流程 ----------
const startedAt = Date.now();
console.log("========== mianshi-agent 端到端评测 v2（客观判定为主） ==========");
console.log(`模式: ${QUICK ? "quick（2 题）" : "full"} | ${new Date().toLocaleString("zh-CN")}\n`);

const questions = load("questions.json").questions;
const classify = load("classify.json").cases;
const detect = load("detect.json").cases;
const evalQuestions = QUICK ? questions.slice(0, 2) : questions;

console.log(`【1/4】讲解质量（${evalQuestions.length} 题：${evalQuestions.map((q) => q.type).join("/")}）...`);
const qResults = [];
for (const q of evalQuestions) {
  const start = Date.now();
  try {
    const r = await evalQuestion(q);
    qResults.push(r);
    const covNote = r.covMissing.length ? ` 缺:${r.covMissing.join("、")}` : "";
    const judgeNote = r.judgeOk ? ` judge${r.judge}` : " judge失败";
    console.log(`  ${r.objective === 50 || q.type === "coverage" ? "✅" : "❌"} ${r.id} ${r.title.slice(0, 18)}: ${r.score}分 [客观${r.objective} 覆盖${r.covRate}%${judgeNote}] ${r.detail}${covNote}`);
  } catch (e) {
    qResults.push({ id: q.id, title: q.title, type: q.type, score: 0, objective: 0, covRate: 0, covHit: [], covMissing: q.must_cover || [], judge: 0, detail: `失败: ${e.message.slice(0, 50)}`, answerLen: 0 });
    console.log(`  ❌ ${q.id} ${q.title.slice(0, 18)}: ${e.message.slice(0, 60)}`);
  }
  await sleep(300);
}
const qScore = Math.round(qResults.reduce((s, r) => s + r.score, 0) / qResults.length);
const codePass = qResults.filter((r) => r.type !== "coverage" && r.objective === 50).length;
const codeTotal = qResults.filter((r) => r.type !== "coverage").length;
console.log(`  → 讲解均分: ${qScore}/100（客观代码/输出验证 ${codePass}/${codeTotal} 通过）\n`);

console.log(`【2/4】页面分类（${classify.length} 样本）...`);
const cRes = await runClassify(classify);
console.log(`  → 分类准确率: ${cRes.rate}% (${cRes.pass}/${cRes.total})\n`);

console.log(`【3/4】题目检测（${detect.length} 样本）...`);
const dRes = await runDetect(detect);
console.log(`  → 检测准确率: ${dRes.rate}% (${dRes.pass}/${dRes.total})\n`);

const sRes = runStatic();
console.log(`【4/4】知识点匹配（${sRes.total} 组静态断言）...`);
console.log(`  → 匹配准确率: ${sRes.rate}%\n`);

const composite = Math.round(qScore * 0.5 + cRes.rate * 0.15 + dRes.rate * 0.2 + sRes.rate * 0.15);
console.log("========== 评测结果 ==========");
console.log(`讲解质量:   ${qScore}/100（客观代码验证 ${codePass}/${codeTotal}）`);
console.log(`分类准确率: ${cRes.rate}%`);
console.log(`检测准确率: ${dRes.rate}%`);
console.log(`静态匹配:   ${sRes.rate}%`);
console.log(`综合评分:   ${composite}/100`);
console.log(`耗时:       ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

if (!NO_SAVE) {
  const reportsDir = path.join(ROOT, "benchmark", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const report = {
    ts: new Date().toISOString(), mode: QUICK ? "quick" : "full", composite,
    dims: { solve: qScore, codePass: `${codePass}/${codeTotal}`, classify: cRes.rate, detect: dRes.rate, static: sRes.rate },
    details: { questions: qResults, classify: cRes.results, detect: dRes.results, static: sRes.results },
  };
  writeFileSync(path.join(reportsDir, `${ts}.json`), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(reportsDir, "latest.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n报告已保存: benchmark/reports/${ts}.json`);
}
process.exit(0);
