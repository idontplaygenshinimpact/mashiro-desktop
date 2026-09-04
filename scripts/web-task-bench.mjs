// scripts/web-task-bench.mjs
// Web 任务成功率评测（WebArena 风格）：固定真实任务，真实 LLM + 真实网络端到端运行，
// 只验证「最终产物」而非执行过程——不看调了哪些工具，只看最终回答 / output 里的归档文件。
//
// 判定类型（tasks.json 里 judge.type）：
//   answer_contains  回复文本命中全部 requiredKeywords（AND）
//   output_file      output/ 出现新文件，且（文件名或内容）命中任意 requiredKeyword（OR），数量 >= minFiles
//   solved_question  output/ 新文件内容含「结论」+「原理」，且命中任意 requiredKeyword（OR），数量 >= minFiles
//
// 失败分类（failureCategory）：
//   timeout          单任务超过 timeoutMs 仍未返回
//   network_error    harness 层抛出网络类错误（LLM/抓取全链路网络失败）
//   no_artifact      什么都没产出（无回复 / 无新输出文件）
//   partial_artifact 有产出但不完整（回复过短 / 命中文件数不足 minFiles）
//   wrong_content    产物齐全但内容不满足关键词/格式要求
//
// 用法：
//   node scripts/web-task-bench.mjs                 # 跑全部任务
//   node scripts/web-task-bench.mjs --task <id>     # 只跑某任务
//   node scripts/web-task-bench.mjs --limit N       # 只跑前 N 个任务（先按 --task 过滤）
//   node scripts/web-task-bench.mjs --dry-run       # 校验 schema + 打印计划（不调 LLM/网络，CI 安全）
//   node scripts/web-task-bench.mjs --no-save       # 不写报告文件
// 报告：benchmark/reports/web-tasks-<timestamp>.json（+ web-tasks-latest.json）
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvalSummary } from "../lib/eval-summary.mjs";
import { computeDatasetHash } from "./validate-evaldata.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASKS_FILE = path.join(ROOT, "benchmark", "web-tasks", "tasks.json");
const OUTPUT_DIR = path.join(ROOT, "output");
const REPORTS_DIR = path.join(ROOT, "benchmark", "reports");

// ---------- CLI 参数 ----------
const argv = process.argv.slice(2);
function argVal(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const DRY_RUN = argv.includes("--dry-run");
const NO_SAVE = argv.includes("--no-save");
const TASK_FILTER = argVal("--task");
const LIMIT_RAW = argVal("--limit");
const LIMIT = LIMIT_RAW !== null && /^\d+$/.test(LIMIT_RAW) ? Number(LIMIT_RAW) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- tasks.json 加载 + schema 校验 ----------
const JUDGE_TYPES = new Set(["answer_contains", "output_file", "solved_question"]);
const DIFFICULTIES = new Set(["easy", "medium", "hard"]);

function validateTasks(tasks) {
  const errors = [];
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, errors: ["tasks.json 顶层缺少非空 tasks 数组"] };
  }
  const ids = new Set();
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const where = (msg) => errors.push(`tasks[${i}]${t?.id ? `(${t.id})` : ""}: ${msg}`);
    if (!t || typeof t !== "object") { where("不是对象"); continue; }
    if (typeof t.id !== "string" || !t.id.trim()) where("缺 id（非空字符串）");
    else if (ids.has(t.id)) where(`id 重复: ${t.id}`);
    else ids.add(t.id);
    if (typeof t.name !== "string" || !t.name.trim()) where("缺 name（非空字符串）");
    if (typeof t.prompt !== "string" || !t.prompt.trim()) where("缺 prompt（非空字符串）");
    if (t.difficulty !== undefined && !DIFFICULTIES.has(t.difficulty)) where(`difficulty 非法: ${t.difficulty}（应为 easy/medium/hard）`);
    const j = t.judge;
    if (!j || typeof j !== "object") { where("缺 judge 对象"); continue; }
    if (!JUDGE_TYPES.has(j.type)) where(`judge.type 非法: ${j.type}（应为 answer_contains/output_file/solved_question）`);
    if (j.minFiles !== undefined && (!Number.isInteger(j.minFiles) || j.minFiles < 1)) where(`judge.minFiles 非法: ${j.minFiles}（应为正整数）`);
    if (j.requiredKeywords !== undefined && (!Array.isArray(j.requiredKeywords) || j.requiredKeywords.some((k) => typeof k !== "string" || !k.trim()))) {
      where("judge.requiredKeywords 应为非空字符串数组");
    }
    if (t.timeoutMs !== undefined && (!Number.isInteger(t.timeoutMs) || t.timeoutMs < 1)) where(`timeoutMs 非法: ${t.timeoutMs}（应为正整数）`);
  }
  return { ok: errors.length === 0, errors };
}

function loadTasks() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
  } catch (e) {
    console.error(`❌ 无法读取/解析 ${path.relative(ROOT, TASKS_FILE)}: ${e.message}`);
    process.exit(1);
  }
  const tasks = raw?.tasks;
  const v = validateTasks(tasks);
  if (!v.ok) {
    console.error("❌ tasks.json schema 校验失败：");
    for (const e of v.errors) console.error(`   - ${e}`);
    process.exit(1);
  }
  return tasks;
}

// ---------- 产物快照（跑任务前后 diff output/ 目录，找出新产出文件） ----------
function snapshotOutputFiles() {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try { map.set(path.relative(OUTPUT_DIR, p), statSync(p).mtimeMs); } catch { /* ignore */ }
      }
    }
  };
  walk(OUTPUT_DIR);
  return map;
}

function diffNewFiles(before, after) {
  const out = [];
  for (const [rel, mtime] of after) {
    if (!before.has(rel) || before.get(rel) !== mtime) out.push(rel);
  }
  return out;
}

function readFiles(relPaths) {
  const out = [];
  for (const rel of relPaths) {
    try {
      out.push({ rel, content: readFileSync(path.join(OUTPUT_DIR, rel), "utf8") });
    } catch { /* ignore */ }
  }
  return out;
}

// ---------- 判定（只验证最终产物） ----------
function judgeTask(judge, reply, fileContents) {
  const type = judge.type;
  const keywords = (judge.requiredKeywords || []).map((k) => String(k).toLowerCase());
  const minFiles = judge.minFiles ?? 1;
  const lowerReply = String(reply || "").toLowerCase();

  if (type === "answer_contains") {
    const missing = keywords.filter((k) => !lowerReply.includes(k));
    return { pass: missing.length === 0, matched: keywords.length - missing.length, total: keywords.length, missing };
  }

  // output_file / solved_question：都在 output/ 新文件里找
  const matched = fileContents.filter((f) => {
    const hay = (f.rel + "\n" + f.content).toLowerCase();
    if (type === "solved_question" && !(f.content.includes("结论") && f.content.includes("原理"))) return false;
    if (!keywords.length) return true;
    return keywords.some((k) => hay.includes(k));
  });
  return { pass: matched.length >= minFiles, matched: matched.map((f) => f.rel), minFiles, fileCount: fileContents.length };
}

// ---------- 失败分类 ----------
const NETWORK_RE = /fetch failed|network|ECONN|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|LLM \d{3}|abort/i;

function categorize({ timedOut, error, judge, reply, fileContents, judgeResult }) {
  if (timedOut) return { pass: false, failureCategory: "timeout" };
  if (error) {
    return { pass: false, failureCategory: NETWORK_RE.test(String(error)) ? "network_error" : "no_artifact" };
  }
  if (judge.type === "answer_contains") {
    const r = String(reply || "").trim();
    if (!r) return { pass: false, failureCategory: "no_artifact" };
    if (judgeResult.pass) return { pass: true, failureCategory: null };
    return { pass: false, failureCategory: r.length < 40 ? "partial_artifact" : "wrong_content" };
  }
  // 文件类判定
  const count = fileContents.length;
  const matched = (judgeResult.matched || []).length;
  const minFiles = judge.minFiles ?? 1;
  if (judgeResult.pass) return { pass: true, failureCategory: null };
  if (count === 0) return { pass: false, failureCategory: "no_artifact" };
  if (matched > 0 && matched < minFiles) return { pass: false, failureCategory: "partial_artifact" };
  if (matched === 0) return { pass: false, failureCategory: "wrong_content" };
  return { pass: false, failureCategory: "partial_artifact" };
}

// ---------- 单任务执行（带超时 + 自动批准 confirm 级工具） ----------
async function runTask(task) {
  const { chatWithAgent } = await import("../lib/agent.mjs");
  const { getPendingApprovals, resolveApproval } = await import("../lib/permission.mjs");
  const timeoutMs = task.timeoutMs ?? 600000;

  const before = snapshotOutputFiles();
  const start = Date.now();

  // deny-first 权限系统：solve_question 属 confirm 级，headless 跑评测需模拟用户批准
  const approveTimer = setInterval(() => {
    for (const a of getPendingApprovals()) resolveApproval(a.toolName, { allow: true, session: true });
  }, 100);

  let reply = "";
  let error = null;
  let timedOut = false;
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("__TASK_TIMEOUT__")), timeoutMs)
    );
    // 传显式 history 隔离各任务（否则 chatWithAgent 会回读持久化对话历史，跨任务污染）
    const r = await Promise.race([chatWithAgent(task.prompt, [{ role: "assistant", content: "" }]), timeoutPromise]);
    reply = typeof r?.reply === "string" ? r.reply : "";
  } catch (e) {
    if (e?.message === "__TASK_TIMEOUT__") timedOut = true;
    else error = e?.message || String(e);
  } finally {
    clearInterval(approveTimer);
  }

  const durationMs = Date.now() - start;
  const after = snapshotOutputFiles();
  const newFiles = diffNewFiles(before, after);
  const fileContents = readFiles(newFiles);

  const judgeResult = judgeTask(task.judge, reply, fileContents);
  const cat = categorize({ timedOut, error, judge: task.judge, reply, fileContents, judgeResult });

  return {
    task: task.id,
    name: task.name,
    difficulty: task.difficulty,
    judgeType: task.judge.type,
    pass: cat.pass ? 1 : 0,
    durationMs,
    artifactPath: newFiles.length ? newFiles : null,
    evidence: cat.pass
      ? (task.judge.type === "answer_contains" ? reply.slice(0, 200) : (judgeResult.matched || []).join(", "))
      : (error ? String(error).slice(0, 200) : reply.slice(0, 200)),
    failureCategory: cat.failureCategory,
    newFileCount: newFiles.length,
    matchedFileCount: Array.isArray(judgeResult.matched) ? judgeResult.matched.length : 0,
    keywordMatched: task.judge.type === "answer_contains" ? judgeResult.matched : null,
    keywordTotal: task.judge.type === "answer_contains" ? judgeResult.total : null,
  };
}

// ---------- 主流程 ----------
const allTasks = loadTasks();

// --dry-run：校验 + 打印计划，不碰 LLM/网络/配置
if (DRY_RUN) {
  let plan = TASK_FILTER ? allTasks.filter((t) => t.id === TASK_FILTER) : allTasks;
  if (LIMIT !== null) plan = plan.slice(0, LIMIT);
  if (TASK_FILTER && plan.length === 0) {
    console.error(`❌ 未找到任务: ${TASK_FILTER}`);
    process.exit(1);
  }
  console.log("========== Web 任务成功率评测 · 计划（dry-run，未调用 LLM/网络） ==========");
  console.log(`任务总数: ${allTasks.length}（easy ${allTasks.filter((t) => t.difficulty === "easy").length} / medium ${allTasks.filter((t) => t.difficulty === "medium").length} / hard ${allTasks.filter((t) => t.difficulty === "hard").length}）`);
  console.log(`本次将运行: ${plan.length} 个任务\n`);
  for (const t of plan) {
    const j = t.judge;
    const kw = (j.requiredKeywords || []).join("、") || "（无）";
    const mf = j.type !== "answer_contains" ? ` minFiles=${j.minFiles ?? 1}` : "";
    console.log(`  [${t.difficulty.padEnd(6)}] ${t.id.padEnd(16)} ${t.name}`);
    console.log(`            判定: ${j.type}${mf} | 关键词: ${kw} | 超时: ${(t.timeoutMs ?? 600000) / 1000}s`);
  }
  console.log("\n✅ schema 校验通过，计划如上（--dry-run 不会消耗 API 额度）");
  process.exit(0);
}

// 真实运行：先加载 API key（fail-fast）
const { config } = await import("../config.mjs");
if (!config.apiKey || !/^(sk-|deepseek-)/.test(config.apiKey)) {
  console.error(
    "\n❌ 未找到有效的 DeepSeek API Key，无法运行真实评测。\n" +
    "  请在项目根目录 .env 配置 DEEPSEEK_API_KEY=sk-xxx\n" +
    "  或设置环境变量 DEEPSEEK_API_KEY（也可复用 opencode 的 key）。\n" +
    "  提示：可用 node scripts/web-task-bench.mjs --dry-run 先校验任务集（无需 key）。\n"
  );
  process.exit(1);
}

// 隔离 DB/MCP（必须在 import agent.mjs 之前），避免污染真实 mianshi.db / 复用真实 MCP server
const { setupTempDb } = await import("../tests/helpers.mjs");
setupTempDb("web-bench");

let tasks = TASK_FILTER ? allTasks.filter((t) => t.id === TASK_FILTER) : allTasks;
if (LIMIT !== null) tasks = tasks.slice(0, LIMIT);
if (TASK_FILTER && tasks.length === 0) {
  console.error(`❌ 未找到任务: ${TASK_FILTER}`);
  process.exit(1);
}

const startedAt = Date.now();
console.log("========== Web 任务成功率评测（真实 LLM + 真实网络，WebArena 风格） ==========");
console.log(`任务数: ${tasks.length} | 模型: ${config.model} | ${new Date().toLocaleString("zh-CN")}`);
console.log("⚠️  本评测会真实消耗 LLM token + 抓取网页，请留意成本\n");

const results = [];
for (const t of tasks) {
  console.log(`【${t.id}】${t.name}...`);
  const r = await runTask(t);
  results.push(r);
  const emoji = r.pass ? "✅" : "❌";
  const cat = r.failureCategory ? `（${r.failureCategory}）` : "";
  const dur = (r.durationMs / 1000).toFixed(0) + "s";
  const hitInfo = r.judgeType === "answer_contains"
    ? `关键词命中 ${r.keywordMatched}/${r.keywordTotal}`
    : `新文件 ${r.newFileCount} | 命中 ${r.matchedFileCount}`;
  console.log(`  ${emoji} pass=${r.pass} | 耗时 ${dur} | ${hitInfo}${cat}`);
  if (!r.pass && r.evidence) console.log(`    证据: ${r.evidence.slice(0, 100).replace(/\n/g, " ")}`);
  if (t !== tasks[tasks.length - 1]) await sleep(1000);
}

// ---------- 汇总 ----------
const passed = results.filter((r) => r.pass).length;
const passRate = results.length ? Math.round((passed / results.length) * 1000) / 10 : 0;
const avgDurationMs = results.length ? Math.round(results.reduce((s, r) => s + r.durationMs, 0) / results.length) : 0;
const byCategory = { timeout: 0, network_error: 0, no_artifact: 0, partial_artifact: 0, wrong_content: 0 };
for (const r of results) {
  if (r.failureCategory && byCategory[r.failureCategory] !== undefined) byCategory[r.failureCategory]++;
}

console.log("\n========== 评测结果汇总 ==========");
console.log(`通过率: ${passed}/${results.length} = ${passRate}%`);
console.log(`失败分类: timeout ${byCategory.timeout} | network_error ${byCategory.network_error} | no_artifact ${byCategory.no_artifact} | partial_artifact ${byCategory.partial_artifact} | wrong_content ${byCategory.wrong_content}`);
console.log(`平均耗时: ${(avgDurationMs / 1000).toFixed(0)}s | 总耗时: ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);

const report = {
  ts: new Date().toISOString(),
  mode: "web-tasks",
  config: { model: config.model },
  passed,
  total: results.length,
  passRate,
  byCategory,
  avgDurationMs,
  totalDurationMs: Date.now() - startedAt,
  tasks: results,
};

if (!NO_SAVE) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const outFile = path.join(REPORTS_DIR, `web-tasks-${ts}.json`);
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  writeFileSync(path.join(REPORTS_DIR, "web-tasks-latest.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n报告已保存: benchmark/reports/web-tasks-${ts}.json`);
}
// eval_summary.csv 行（layer=web；成本/延迟留空——web 任务耗时在 avgDurationMs）
try {
  const tasks = JSON.parse(readFileSync(TASKS_FILE, "utf8"));
  appendEvalSummary([
    new Date().toISOString(), "web", "web-tasks",
    computeDatasetHash(tasks.version ?? 2, tasks.tasks || []),
    config.model || "", Math.round(passRate), 0, 0, 0, 0, 0, 0,
    "", "", "", "", passRate, 0, 0,
  ]);
} catch { /* summary 失败不影响主流程 */ }

// web_search/fetch_page 会缓存 Playwright chromium 实例，不关闭则进程不退出；关闭后正常结束
try {
  const { closeBrowser } = await import("../lib/fetch-page.mjs");
  await closeBrowser();
} catch { /* ignore */ }
process.exit(0);
