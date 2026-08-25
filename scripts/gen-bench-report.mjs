// 评测可视化报告生成（Phase 评测 W4 §6.1：无前端依赖）
// 用法: node scripts/gen-bench-report.mjs [--write-readme]
// 读 eval_summary.csv：
//   1) 最近一次 A 层 full 运行 → README 徽章片段（文本 + shields.io 动态 badge URL）
//   2) 最近 8 次 A 层 composite/truthfulness 趋势 → benchmark/trend.svg（纯字符串拼折线）
import { readEvalSummary } from "../lib/eval-summary.mjs";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(import.meta.dirname, "..");
const WRITE_README = process.argv.includes("--write-readme");

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

/** 最近一次指定 layer+mode 的运行行（默认取主评测 full/quick——ablation 的 composite 列是 Δ 非综合分，不冒充徽章） */
export function latestRun(rows, { layer = "A", modes = ["full", "quick"] } = {}) {
  const cands = (rows || []).filter((r) => r.layer === layer && modes.includes(r.mode));
  cands.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return cands.length ? cands[cands.length - 1] : null;
}

/** 徽章文本：`[Eval: 82/100 · CRAG 82% · 分类 93%]` */
export function buildBadgeText(run) {
  if (!run) return null;
  const parts = [];
  if (run.composite !== "") parts.push(`Eval: ${num(run.composite) ?? "-"}/100`);
  if (run.truthfulness !== "") parts.push(`CRAG ${num(run.truthfulness) ?? "-"}%`);
  if (run.classifyRate !== "") parts.push(`分类 ${num(run.classifyRate) ?? "-"}%`);
  return parts.length ? parts.join(" · ") : null;
}

/** shields.io 动态徽章 URL（query 编码，标题固定） */
export function buildBadgeUrl(text, label = "mashiro-eval") {
  return `https://img.shields.io/badge/${encodeURIComponent(label)}-${encodeURIComponent(text.replace(/[··]/g, "_"))}-blue`;
}

/** trend.svg：最近 n 次 composite/truth 折线（纯字符串拼接，无依赖） */
export function buildTrendSvg(rows, n = 8) {
  const aRuns = (rows || []).filter((r) => r.layer === "A" && r.composite !== "");
  aRuns.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  const recent = aRuns.slice(-n);
  if (!recent.length) return null;
  const W = 640, H = 220, padL = 48, padR = 16, padT = 24, padB = 30;
  const vals = recent.map((r) => ({
    composite: num(r.composite) ?? 0,
    truth: num(r.truthfulness) ?? 0,
    label: String(r.ts).slice(5, 10),
  }));
  const maxV = 100;
  const x = (i) => padL + (i * (W - padL - padR)) / Math.max(1, recent.length - 1);
  const y = (v) => H - padB - (Math.min(maxV, Math.max(0, v)) / maxV) * (H - padT - padB);
  const poly = (key) => vals.map((v, i) => `${x(i).toFixed(1)},${y(v[key]).toFixed(1)}`).join(" ");
  const dots = (key) => vals.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v[key]).toFixed(1)}" r="3" fill="${key === "composite" ? "#6d4fd8" : "#3a8d5a"}"/>`).join("\n");
  const labels = vals.map((v, i) => `<text x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#8a87a8">${v.label}</text>`).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <text x="${padL}" y="16" font-size="12" fill="#4a4868" font-weight="bold">Mashiro Eval 趋势（最近 ${recent.length} 次 A 层运行）</text>
  <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="#e0dfe8"/>
  <polyline points="${poly("composite")}" fill="none" stroke="#6d4fd8" stroke-width="2"/>
  <polyline points="${poly("truth")}" fill="none" stroke="#3a8d5a" stroke-width="2"/>
  ${dots("composite")}
  ${dots("truth")}
  ${labels}
  <text x="${W - padR - 8}" y="34" text-anchor="end" font-size="10" fill="#6d4fd8">综合</text>
  <text x="${W - padR - 8}" y="48" text-anchor="end" font-size="10" fill="#3a8d5a">CRAG 真实性</text>
</svg>`;
}

// 脚本入口
if (process.argv[1] && process.argv[1].endsWith("gen-bench-report.mjs")) {
  const rows = readEvalSummary();
  const run = latestRun(rows);
  const badge = buildBadgeText(run);
  const svg = buildTrendSvg(rows);
  if (badge) {
    const url = buildBadgeUrl(badge);
    console.log("徽章文本:", badge);
    console.log("徽章 URL :", url);
    console.log("Markdown 片段:");
    console.log(`[![Eval](${url})](benchmark/trend.svg)`);
  } else {
    console.log("暂无 A 层运行数据（先跑 npm run bench 或 bench:ablation）");
  }
  if (svg) {
    mkdirSync(path.join(ROOT, "benchmark"), { recursive: true });
    writeFileSync(path.join(ROOT, "benchmark", "trend.svg"), svg, "utf8");
    console.log("\ntrend.svg 已生成");
  }
  if (WRITE_README && badge && existsSync(path.join(ROOT, "README.md"))) {
    const readme = readFileSync(path.join(ROOT, "README.md"), "utf8");
    const marker = "<!-- EVAL_BADGE -->";
    const snippet = `${marker}\n[![Eval](${buildBadgeUrl(badge)})](benchmark/trend.svg)\n`;
    const next = readme.includes(marker)
      ? readme.replace(new RegExp(`${marker}[\\s\\S]*?\\n\\n`), snippet + "\n")
      : readme;
    if (next !== readme) {
      writeFileSync(path.join(ROOT, "README.md"), next, "utf8");
      console.log("README 徽章片段已写入");
    }
  }
  process.exit(0);
}