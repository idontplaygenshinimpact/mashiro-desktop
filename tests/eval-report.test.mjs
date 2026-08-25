// gen-bench-report 纯函数单测（Phase 评测 W4：徽章/趋势生成，无依赖）
import { test } from "node:test";
import assert from "node:assert/strict";

const rows = [
  { ts: "2026-01-01T00:00:00Z", layer: "A", mode: "full", composite: "70", truthfulness: "50", classifyRate: "90" },
  { ts: "2026-01-02T00:00:00Z", layer: "A", mode: "full", composite: "75", truthfulness: "60", classifyRate: "92" },
  { ts: "2026-01-03T00:00:00Z", layer: "B", mode: "agent", composite: "100", truthfulness: "", classifyRate: "" },
  { ts: "2026-01-04T00:00:00Z", layer: "A", mode: "ablation", composite: "12", truthfulness: "30", classifyRate: "" },
];

test("latestRun：取最近一次 A 层（full 优先于 ablation）", async () => {
  const { latestRun } = await import("../scripts/gen-bench-report.mjs");
  const r = latestRun(rows, { layer: "A" });
  assert.equal(r.ts, "2026-01-04T00:00:00Z", "默认 modes 含 ablation 时取最新");
  const r2 = latestRun(rows, { layer: "A", modes: ["full"] });
  assert.equal(r2.ts, "2026-01-02T00:00:00Z", "限定 full 模式");
  assert.equal(latestRun(rows, { layer: "X" }), null, "无该层 → null");
});

test("buildBadgeText：文本组装 + 无数据返回 null", async () => {
  const { buildBadgeText } = await import("../scripts/gen-bench-report.mjs");
  const t = buildBadgeText(rows[1]);
  assert.ok(t.includes("Eval: 75/100") && t.includes("CRAG 60%") && t.includes("分类 92%"), t);
  assert.equal(buildBadgeText(null), null);
});

test("buildBadgeUrl：shields.io URL 编码（防特殊字符破坏）", async () => {
  const { buildBadgeUrl } = await import("../scripts/gen-bench-report.mjs");
  const u = buildBadgeUrl("Eval: 75/100 · CRAG 60%");
  assert.ok(u.startsWith("https://img.shields.io/badge/"), u);
  assert.ok(!u.includes(" "), "空格被编码");
  assert.ok(u.includes("%25"), "百分号被编码为 %25（60% → 60%25）");
  assert.ok(!u.includes(" 60%"), "原始百分号不存在");
});

test("buildTrendSvg：最近 N 次折线 + 少于 1 次返回 null", async () => {
  const { buildTrendSvg } = await import("../scripts/gen-bench-report.mjs");
  const svg = buildTrendSvg(rows, 4);
  assert.ok(svg.startsWith("<svg") && svg.endsWith("</svg>"), "SVG 结构");
  assert.ok(svg.includes('stroke="#6d4fd8"'), "composite 折线");
  assert.ok(svg.includes('stroke="#3a8d5a"'), "truth 折线");
  assert.ok(svg.includes("Mashiro Eval 趋势"), "标题");
  assert.equal(buildTrendSvg([]), null);
});