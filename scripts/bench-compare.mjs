// 回归对比 + 分层门禁（Phase 评测 W2 §4.3）
// 用法: node scripts/bench-compare.mjs [--gate] [--report benchmark/reports/comparison-latest.json]
// 读取 eval_summary.csv，对同 layer ∧ 同 datasetHash 的最近两次输出 Δ 表。
// 分层门禁（诚实设计，小样本不误杀）：
//   硬红（--gate 时 exit 1）：classify/detect/static 任一降 >3%（确定性高、样本大）
//   黄牌（exit 0 + ⚠️）：solve/truthfulness 降 3~5%（波动大；连续 2 次同向才升级红）
// 数据集变更（hash 不同）不跨集对比，只提示。
import { readEvalSummary, SUMMARY_FILE } from "../lib/eval-summary.mjs";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const GATE = process.argv.includes("--gate");
const reportIdx = process.argv.indexOf("--report");
const REPORT = reportIdx >= 0 && process.argv[reportIdx + 1] ? path.join(import.meta.dirname, "..", process.argv[reportIdx + 1]) : null;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const pct = (n) => (n === null ? "-" : `${Math.round(n * 10) / 10}%`);
const delta = (cur, prev) => {
  if (cur === null || prev === null) return null;
  return Math.round((cur - prev) * 10) / 10;
};
const arrow = (d) => (d === null ? "  " : d > 0 ? " ↑" : d < 0 ? " ↓" : " →");

export function compareRunsFromRows(rows) {
  if (!rows || !rows.length) return { ok: true, notice: "无历史数据", hardFails: [], warnings: [], groups: [] };
  // 按 (layer, datasetHash, mode) 分组（hash 空的行不参与对比；mode 隔离——ablation 的
  // composite 列是 Δ 非综合分，与 full/quick 混比会误导）
  const groups = new Map();
  for (const r of rows) {
    if (!r.layer || !r.datasetHash) continue;
    const key = `${r.layer}|${r.datasetHash}|${r.mode || ""}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const out = [];
  const hardFails = [];
  const warnings = [];
  for (const [key, runs] of groups) {
    const sorted = runs.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    if (sorted.length < 2) continue; // 只有一次 → 无对比
    const [layer, hash, mode] = key.split("|");
    const prev = sorted[sorted.length - 2];
    const cur = sorted[sorted.length - 1];
    const DIMS = [
      ["composite", "综合"],
      ["solveScore", "讲解"],
      ["truthfulness", "真实性"],
      ["classifyRate", "分类"],
      ["detectRate", "检测"],
      ["staticRate", "静态"],
      ["traceScore", "TRACe"],
      ["costUsd", "成本$"],
      ["p50Ms", "P50ms"],
      ["p95Ms", "P95ms"],
    ];
    const diff = {};
    for (const [k] of DIMS) diff[k] = delta(num(cur[k]), num(prev[k]));
    out.push({ layer, hash, prevTs: prev.ts, curTs: cur.ts, diff });
    console.log(`\n【${layer} · ${hash}】${cur.ts.slice(0, 19)} vs ${prev.ts.slice(0, 19)}`);
    for (const [k, label] of DIMS) {
      const d = diff[k];
      console.log(`  ${label.padEnd(8)} ${pct(num(cur[k]))} ${arrow(d)} ${d === null ? "-" : (d > 0 ? "+" : "") + d}（${pct(num(prev[k]))}）`);
    }
    // 分层门禁
    const curNum = (k) => num(cur[k]);
    for (const k of ["classifyRate", "detectRate", "staticRate"]) {
      const d = diff[k];
      if (d !== null && d < -3) {
        hardFails.push(`${layer}/${k} 降 ${-d}pt（${pct(curNum(k))}，门槛 >3pt 降级红）`);
        console.log(`  ❌ 硬红: ${k} 降 ${-d}pt`);
      }
    }
    for (const k of ["solveScore", "truthfulness"]) {
      const d = diff[k];
      if (d !== null && d < -3 && d >= -5) {
        // 黄牌：需连续 2 次同向才升级红——检查再前一次
        const prev2 = sorted.length >= 3 ? sorted[sorted.length - 3] : null;
        const d2 = prev2 ? delta(num(prev[k]), num(prev2[k])) : null;
        const escalate = d2 !== null && d2 < 0;
        if (escalate) {
          hardFails.push(`${layer}/${k} 连续两次下降（本次 ${d}pt、上次 ${d2}pt）→ 升级红`);
          console.log(`  ❌ 红(连续2次): ${k} 本次 ${d}pt、上次 ${d2}pt`);
        } else {
          warnings.push(`${layer}/${k} 降 ${-d}pt（黄牌观察中）`);
          console.log(`  ⚠️ 黄牌: ${k} 降 ${-d}pt（连续 2 次同向才升级红）`);
        }
      }
    }
  }
  // 数据集变更提示：存在 hash 与最近 A 层不同的行
  const aHashes = new Set(rows.filter((r) => r.layer === "A").map((r) => r.datasetHash).filter(Boolean));
  if (aHashes.size > 1) console.log(`\nℹ️ 检测到 A 层存在 ${aHashes.size} 个数据集 hash——跨集对比已按 hash 隔离（不拿不同样本数当回归）`);
  return { ok: hardFails.length === 0, hardFails, warnings, groups: out };
}

// 脚本入口
if (process.argv[1] && process.argv[1].endsWith("bench-compare.mjs")) {
  const r = compareRunsFromRows(readEvalSummary());
  if (REPORT) {
    mkdirSync(path.dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, JSON.stringify({ ts: new Date().toISOString(), gate: GATE, ...r }, null, 2), "utf8");
    console.log(`\ncomparison 已写: ${REPORT}`);
  }
  if (!r.groups.length) console.log(`\n无同 hash 对比对（历史不足或 hash 隔离）——非失败，只是没有可比样本`);
  if (GATE && r.hardFails.length) {
    console.error(`\n门禁失败（${r.hardFails.length} 项）：\n  ${r.hardFails.join("\n  ")}`);
    process.exit(1);
  }
  if (r.hardFails.length && !GATE) console.log(`\n⚠️ 存在硬红项（未开 --gate，exit 0）`);
  process.exit(0);
}
