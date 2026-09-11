// 评测期 LLM 成本/延迟汇总（Phase 评测 W2 §4.1）
// 数据源：lib/llm.mjs 的内建评测计数器（startEvalMetrics → 调用 → getEvalMetrics）
// 单价常量可配（环境变量 EVAL_COST_IN_M / EVAL_COST_OUT_M，单位 美元/百万 tokens）；
// 默认按通用对话模型价位（in $0.2/M、out $0.4/M 量级），评测 README 会写"估算口径"。
const IN_PER_M = Number(process.env.EVAL_COST_IN_M) || 0.2;
const OUT_PER_M = Number(process.env.EVAL_COST_OUT_M) || 0.4;

/** 单次 LLM 调用指标（llm.mjs 评测计数器产出；tokens 可为 null——失败/流式中断） */
export interface EvalMetric {
  ts: number;
  tag: string;
  ok: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number;
  model?: string;
}

/** 按 tag 分账（调用数/令牌/耗时/失败数） */
export interface EvalTagAgg {
  calls: number;
  tokens: number;
  ms: number;
  fails: number;
}

/** summarizeEvalCost 汇总结果（成功调用计费；p50/p95 基于成功调用延迟） */
export interface EvalCostSummary {
  calls: number;
  failCount: number;
  costTokens: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  p50Ms: number;
  p95Ms: number;
  byTag: Record<string, EvalTagAgg>;
  model?: string;
}

function pct(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

/**
 * 汇总评测期 LLM 指标
 * @returns 调用数/失败数/令牌与成本/延迟分位/按 tag 分账/首个出现的 model
 */
export function summarizeEvalCost(metrics: EvalMetric[] | null | undefined): EvalCostSummary {
  const list = Array.isArray(metrics) ? metrics : [];
  const byTag: Record<string, EvalTagAgg> = {};
  for (const m of list) {
    const tag = m.tag || "misc";
    const t = byTag[tag] || (byTag[tag] = { calls: 0, tokens: 0, ms: 0, fails: 0 });
    t.calls++;
    t.tokens += (m.inputTokens || 0) + (m.outputTokens || 0);
    t.ms += m.durationMs || 0;
    if (!m.ok) t.fails++;
  }
  const okCalls = list.filter((m) => m.ok);
  const inputTokens = okCalls.reduce((s, m) => s + (m.inputTokens || 0), 0);
  const outputTokens = okCalls.reduce((s, m) => s + (m.outputTokens || 0), 0);
  const costTokens = inputTokens + outputTokens;
  const costUsd = Math.round((inputTokens / 1e6 * IN_PER_M + outputTokens / 1e6 * OUT_PER_M) * 1e4) / 1e4;
  const durs = okCalls.map((m) => m.durationMs || 0);
  const model = list.find((m) => m.model)?.model;
  return {
    calls: list.length,
    failCount: list.length - okCalls.length,
    costTokens,
    costUsd,
    inputTokens,
    outputTokens,
    p50Ms: Math.round(pct(durs, 50)),
    p95Ms: Math.round(pct(durs, 95)),
    byTag,
    model,
  };
}

/** 成本/延迟的人话一行（benchmark 输出用） */
export function formatEvalCost(sum: EvalCostSummary): string {
  const tagParts = Object.entries(sum.byTag)
    .map(([tag, t]) => `${tag}:${t.calls}次/${t.tokens}tok`)
    .join(" ");
  return `LLM ${sum.calls} 次调用（${sum.failCount} 失败）· ${sum.costTokens.toLocaleString()} tokens ≈ $${sum.costUsd} · p50 ${sum.p50Ms}ms / p95 ${sum.p95Ms}ms · ${tagParts}`;
}
