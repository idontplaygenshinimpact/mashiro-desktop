// 评测期 LLM 成本/延迟汇总（Phase 评测 W2 §4.1）
// 数据源：lib/llm.mjs 的内建评测计数器（startEvalMetrics → 调用 → getEvalMetrics）
// 单价常量可配（环境变量 EVAL_COST_IN_M / EVAL_COST_OUT_M，单位 美元/百万 tokens）；
// 默认按通用对话模型价位（in $0.2/M、out $0.4/M 量级），评测 README 会写"估算口径"。
const IN_PER_M = Number(process.env.EVAL_COST_IN_M) || 0.2;
const OUT_PER_M = Number(process.env.EVAL_COST_OUT_M) || 0.4;

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return s[i];
}

/**
 * 汇总评测期 LLM 指标
 * @param {Array<{ts: number, tag: string, ok: boolean, inputTokens: number|null, outputTokens: number|null, durationMs: number, model?: string}>} metrics
 * @returns {{ calls: number, failCount: number, costTokens: number, costUsd: number,
 *   inputTokens: number, outputTokens: number, p50Ms: number, p95Ms: number,
 *   byTag: Record<string, {calls: number, tokens: number, ms: number}>, model?: string }}
 */
export function summarizeEvalCost(metrics) {
  const list = Array.isArray(metrics) ? metrics : [];
  /** @type {Record<string, {calls: number, tokens: number, ms: number, fails: number}>} */
  const byTag = {};
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
export function formatEvalCost(sum) {
  const tagParts = Object.entries(sum.byTag || {})
    .map(([tag, t]) => `${tag}:${t.calls}次/${t.tokens}tok`)
    .join(" ");
  return `LLM ${sum.calls} 次调用（${sum.failCount} 失败）· ${sum.costTokens.toLocaleString()} tokens ≈ $${sum.costUsd} · p50 ${sum.p50Ms}ms / p95 ${sum.p95Ms}ms · ${tagParts}`;
}