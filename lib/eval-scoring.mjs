// 评测共享评分栈（Phase 评测 W3 抽取：benchmark.mjs / bench-ablation.mjs 共用，防双实现漂移）
// LLM-as-Judge 双评 + CRAG 事实判官 + must_cover 覆盖度——消融 A/B 与主评测同口径
import { llmChat, extractJson } from "./llm.mjs";

export const TRUTH_LABEL_SCORE = { correct: 100, acceptable: 75, missing: 50, incorrect: 0 };
export const TRUTH_LABEL_RANK = { correct: 0, acceptable: 1, missing: 2, incorrect: 3 };
export function truthScore(label) { return TRUTH_LABEL_SCORE[label] ?? null; }
export function truthAdjacent(a, b) {
  if (!a || !b || TRUTH_LABEL_RANK[a] === undefined || TRUTH_LABEL_RANK[b] === undefined) return false;
  return Math.abs(TRUTH_LABEL_RANK[a] - TRUTH_LABEL_RANK[b]) <= 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** must_cover 覆盖度（讲解文本命中必考要点） */
export function coverageRate(text, mustCover) {
  const t = String(text || "").toLowerCase();
  const hit = (mustCover || []).filter((k) => t.includes(String(k).toLowerCase()));
  return { hit, rate: (mustCover || []).length ? Math.round((hit.length / mustCover.length) * 100) : 0 };
}

/** 参考要点文本（CRAG 判官用） */
export function refText(q) {
  const parts = [];
  if (q.must_cover?.length) parts.push("必考要点：" + q.must_cover.join("、"));
  if (q.context) parts.push("给定材料：" + String(q.context).slice(0, 3000));
  return parts.join("\n") || "（无参考要点，仅依据题目常识判断事实正误）";
}

/**
 * LLM-as-Judge 四维双评（conclusion/principle/implementation/boundary，各 0-25）
 * 带重试+降级（3 次失败返回 null，评分按无 judge 处理）
 * @returns {Promise<{conclusion:number,principle:number,implementation:number,boundary:number,total:number}|null>}
 */
// 判官 prompt 输出 JSON（四维各 0-25）——评测模型为推理型（deepseek-v4-flash）时
// 200-500 tokens 会被思考消耗殆尽 → 空响应重试/降级（judge 全失败）。预算抬到 2000。
export async function judgeAnswer(q, answer) {
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
      ], { maxTokens: 8000, temperature: 0.2, tag: "judge" });
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);
      if (parsed && typeof parsed.total === "number") return parsed;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}

/**
 * 真实性判官（CRAG，只判事实正确性）：correct/acceptable/missing/incorrect
 * @returns {Promise<{label:string}|null>}
 */
export async function judgeTruthfulness(q, answer) {
  const prompt = `你是事实核查员。下面是一道面试题、参考要点/材料，以及 AI 的讲解。请只判断讲解的**事实正确性**（不评判文笔/结构/详略），输出一个标签：
- correct：讲解的事实全部正确，无错误陈述
- acceptable：基本正确，但有个别不严谨或不完整的轻微瑕疵（不影响结论）
- missing：讲解没有回答题目的核心问题，或避而不答、只重复题干
- incorrect：讲解存在明确的事实错误，或结论与参考要点相悖
题目：${q.title}
${refText(q)}
讲解：${answer.slice(0, 6000)}
只输出 JSON：{"label":"correct|acceptable|missing|incorrect"}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await llmChat([
        { role: "system", content: "你是事实核查员，只输出合法 JSON。" },
        { role: "user", content: prompt },
      ], { maxTokens: 8000, temperature: 0.2, tag: "judge" });
      const content = data?.choices?.[0]?.message?.content ?? "";
      const parsed = extractJson(content);
      if (parsed && TRUTH_LABEL_SCORE[parsed.label] !== undefined) return parsed;
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    } catch {
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  return null;
}