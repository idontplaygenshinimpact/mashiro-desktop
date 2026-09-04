// eval_summary.csv 共享写入（Phase 评测 W2 §4.2）：Layer A/B/web 三轨统一追加行
// 列：ts,layer,mode,datasetHash,llmModel,composite,solveScore,truthfulness,
//     classifyRate,detectRate,staticRate,traceScore,costTokens,costUsd,p50Ms,p95Ms,pass1,failCount,exitCode
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

export const SUMMARY_HEADER = "ts,layer,mode,datasetHash,llmModel,composite,solveScore,truthfulness,classifyRate,detectRate,staticRate,traceScore,costTokens,costUsd,p50Ms,p95Ms,pass1,failCount,exitCode";
export const SUMMARY_DIR = path.join(import.meta.dirname, "..", "benchmark", "reports");
export const SUMMARY_FILE = path.join(SUMMARY_DIR, "eval_summary.csv");

/**
 * 追加一行 summary（字段顺序见 header；缺字段补空）
 * 技术债 L12：CSV 转义——字段含逗号/引号/换行时用双引号包裹 + 内部引号翻倍
 * （此前直接 join(",")——LLM 模型名/错误信息含逗号会破坏列对齐）
 * @param {Array<string|number|null|undefined>} fields
 */
export function appendEvalSummary(fields) {
  try {
    mkdirSync(SUMMARY_DIR, { recursive: true });
    const esc = (f) => {
      const s = f === null || f === undefined ? "" : String(f);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const row = fields.map(esc).join(",");
    writeFileSync(SUMMARY_FILE, (existsSync(SUMMARY_FILE) ? "" : SUMMARY_HEADER + "\n") + row + "\n", { flag: "a" });
    return true;
  } catch (e) {
    console.warn(`[eval-summary] 写入失败: ${String(e?.message || e).slice(0, 100)}`);
    return false;
  }
}

/** 读全部行（bench-compare 用）；返回对象数组或 [] */
export function readEvalSummary() {
  try {
    if (!existsSync(SUMMARY_FILE)) return [];
    const lines = readFileSync(SUMMARY_FILE, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const keys = lines[0].split(",");
    return lines.slice(1).map((l) => {
      const vals = l.split(",");
      const o = /** @type {Record<string,string>} */ ({});
      keys.forEach((k, i) => { o[k] = vals[i] ?? ""; });
      return o;
    });
  } catch { return []; }
}