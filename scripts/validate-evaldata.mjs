// 评测数据合法性校验器（Phase 评测 W1）
// 用法: node scripts/validate-evaldata.mjs [--quiet] [--report benchmark/evaldata-hashes.json]
// 职责:
//   1) 每个数据集文件必须带 version(数字) + meta{generatedBy,updatedAt,note} envelope
//   2) 每个 case 必填 id / source（可追溯：面试被问"样本哪来的"能答）+ 类型枚举合法
//   3) questions: type∈{code,predict,coverage,trace} 且 must_cover 非空
//   4) judge-gold: label∈{correct,acceptable,missing,incorrect}
//   5) web-tasks: judge.type∈{answer_contains,output_file,solved_question}
//   6) 计算 datasetHash（sha256(version + cases 序列化)）——回归对比同 hash 才可比
// 退出码: 任何脏数据 exit 1（CI 用）；--report 另写 hash 文件
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const ROOT = path.join(import.meta.dirname, "..");
const QUIET = process.argv.includes("--quiet");
const reportIdx = process.argv.indexOf("--report");
const REPORT = reportIdx >= 0 && process.argv[reportIdx + 1] ? path.join(ROOT, process.argv[reportIdx + 1]) : null;

// ---------- 数据集定义：文件 → 读取方式 + case 校验 ----------
const DATASETS = [
  {
    name: "questions", file: "benchmark/questions.json", listKey: "questions",
    caseType: "object",
    check(c, errs, ctx) {
      if (!["code", "predict", "coverage", "trace"].includes(c.type)) errs.push(`${ctx}#${c.id}: type 非法 '${c.type}'（code|predict|coverage|trace）`);
      if (c.type !== "trace" && (!Array.isArray(c.must_cover) || !c.must_cover.length)) errs.push(`${ctx}#${c.id}: must_cover 必须非空数组`);
      if (c.type === "predict" && typeof c.expected_stdout !== "string") errs.push(`${ctx}#${c.id}: predict 题必须 expected_stdout`);
      if (c.type === "code" && (typeof c.fn !== "string" || typeof c.test !== "string")) errs.push(`${ctx}#${c.id}: code 题必须 fn+test`);
    },
  },
  {
    name: "classify", file: "benchmark/classify.json", listKey: "cases",
    check(c, errs, ctx) {
      if (!["mianshi", "zhaopin", "bishi", "other"].includes(c.expected)) errs.push(`${ctx}#${c.id}: expected 非法 '${c.expected}'`);
      if (typeof c.text !== "string" || !c.text) errs.push(`${ctx}#${c.id}: text 必填`);
    },
  },
  {
    name: "detect", file: "benchmark/detect.json", listKey: "cases",
    check(c, errs, ctx) {
      if (typeof c.expected !== "boolean") errs.push(`${ctx}#${c.id}: expected 必须是布尔`);
      if (typeof c.text !== "string" || !c.text) errs.push(`${ctx}#${c.id}: text 必填`);
    },
  },
  {
    name: "judge-gold", file: "benchmark/judge-gold.json", listKey: "pairs",
    check(c, errs, ctx) {
      if (!["correct", "acceptable", "missing", "incorrect"].includes(c.label)) errs.push(`${ctx}#${c.id}: label 非法 '${c.label}'（correct|acceptable|missing|incorrect）`);
      if (typeof c.question !== "string" || !c.question) errs.push(`${ctx}#${c.id}: question 必填`);
      if (typeof c.answer !== "string") errs.push(`${ctx}#${c.id}: answer 必填`);
    },
  },
  {
    name: "web-tasks", file: "benchmark/web-tasks/tasks.json", listKey: "tasks",
    check(c, errs, ctx) {
      if (!["easy", "medium", "hard"].includes(c.difficulty)) errs.push(`${ctx}#${c.id}: difficulty 非法 '${c.difficulty}'`);
      const j = c.judge;
      if (!j || !["answer_contains", "output_file", "solved_question"].includes(j.type)) errs.push(`${ctx}#${c.id}: judge.type 非法`);
      if (!Array.isArray(j.requiredKeywords) || !j.requiredKeywords.length) errs.push(`${ctx}#${c.id}: judge.requiredKeywords 非空数组`);
      if (typeof c.prompt !== "string" || !c.prompt) errs.push(`${ctx}#${c.id}: prompt 必填`);
    },
  },
  {
    // 静态用例（从 benchmark.mjs 硬编码迁出）：text → 期望 matchKp 命中 or null
    name: "static", file: "benchmark/static.json", listKey: "cases",
    check(c, errs, ctx) {
      if (typeof c.text !== "string" || !c.text) errs.push(`${ctx}#${c.id}: text 必填`);
      if (c.expected !== null && typeof c.expected !== "string") errs.push(`${ctx}#${c.id}: expected 必须 string|null`);
    },
  },
];

function loadJson(file) {
  const p = path.join(ROOT, file);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}
function hashOf(version, cases) {
  return createHash("sha256").update(`${version}|${JSON.stringify(cases)}`).digest("hex").slice(0, 16);
}
/** datasetHash 计算（benchmark/compare 复用：同 version∧同 cases 才可比） */
export function computeDatasetHash(version, cases) {
  return hashOf(version, cases);
}

/**
 * 校验一个 case 列表（纯函数，数据集无关的强制项 + 各数据集类型枚举）。
 * 强制项：id / source 必填。返回错误数组。
 * @param {string} dsName 数据集名（questions|classify|detect|judge-gold|web-tasks|static）
 * @param {Array<any>} list
 */
export function validateList(dsName, list) {
  const errs = [];
  const ds = DATASETS.find((d) => d.name === dsName);
  const ctx = dsName;
  (Array.isArray(list) ? list : []).forEach((c, i) => {
    const id = String(c?.id || `#${i}`);
    if (!c || typeof c !== "object") { errs.push(`${ctx}[${i}]: case 必须对象`); return; }
    if (!String(c.id || "").trim()) errs.push(`${ctx}[${i}]: 缺少 id`);
    if (typeof c.source !== "string" || !c.source.trim()) errs.push(`${ctx}#${id}: 缺少 source（可追溯来源必填）`);
    ds?.check(c, errs, ctx);
  });
  return errs;
}

/** 校验一个数据集文件；返回 { ok, errors, count, hash, version } */
export function validateDataset(ds) {
  const data = loadJson(ds.file);
  if (!data) return { ok: false, errors: [`${ds.name}: 文件不存在 ${ds.file}`], count: 0, hash: null, version: null };
  const errors = [];
  if (typeof data.version !== "number") errors.push(`${ds.name}: 缺少 version（数字）`);
  if (!data.meta || typeof data.meta.updatedAt !== "string") errors.push(`${ds.name}: 缺少 meta.updatedAt`);
  if (!data.meta || typeof data.meta.generatedBy !== "string") errors.push(`${ds.name}: 缺少 meta.generatedBy`);
  const list = Array.isArray(data[ds.listKey]) ? data[ds.listKey] : null;
  if (!list) { errors.push(`${ds.name}: 缺少数组键 ${ds.listKey}`); }
  errors.push(...validateList(ds.name, list));
  const count = list?.length || 0;
  const hash = list ? hashOf(data.version ?? 0, list) : null;
  return { ok: errors.length === 0, errors, count, hash, version: data.version ?? null };
}

/** 校验全部数据集；返回汇总（脚本入口与测试共用） */
export function validateAll() {
  const out = [];
  let allOk = true;
  for (const ds of DATASETS) {
    const r = validateDataset(ds);
    allOk = allOk && r.ok;
    out.push({ name: ds.name, ...r });
    if (!r.ok) for (const e of r.errors) console.error(`❌ ${e}`);
  }
  return { ok: allOk, datasets: out };
}

// 脚本入口
if (process.argv[1] && process.argv[1].endsWith("validate-evaldata.mjs")) {
  const { ok, datasets } = validateAll();
  const lines = datasets.map((d) => `${d.name}: ${d.ok ? "✅" : "❌"} ${d.count} 样本 hash=${d.hash}${d.version ? ` v${d.version}` : ""}`);
  if (!QUIET) console.log("评测数据集校验：" + (ok ? "全部通过" : "存在脏数据"));
  for (const l of lines) console.log(`  ${l}`);
  if (REPORT) {
    const payload = { ts: new Date().toISOString(), checks: Object.fromEntries(datasets.map((d) => [d.name, { ok: d.ok, count: d.count, hash: d.hash, version: d.version }])) };
    writeFileSync(REPORT, JSON.stringify(payload, null, 2), "utf8");
    if (!QUIET) console.log(`已写 hash 报告: ${REPORT}`);
  }
  process.exit(ok ? 0 : 1);
}