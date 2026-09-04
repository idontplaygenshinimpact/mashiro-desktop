// 模拟面试：STaR 解析 + 五维评分校验 + 薄弱点/复习卡/掌握度回流
// 纵向拆分第 5 刀：interview-scoring 域
import { memory } from "./memory.mjs";

// 过滤伪知识点：考察维度名（"综合能力"/"考察维度：XXX"）、泛化标签、空值 → null
// 只保留"事件循环"、"React 渲染流程"这类具体知识点名
const PSEUDO_PATTERNS = [
  /考察维度/i, /综合能力/, /表达能力/, /^维度/, /^综合/,
  /^沟通/, /^态度/, /^思维/, /^逻辑/, /面试表现/, /整体表现/,
  /^无$/, /^暂无/, /^none$/i, /^null$/i, /^未/,
];

export function cleanWeakTopic(topic) {
  if (!topic) return null;
  const t = String(topic).trim().slice(0, 40);
  if (!t) return null;
  if (t.length > 30) return null; // 太长的多半是句子不是知识点
  for (const p of PSEUDO_PATTERNS) if (p.test(t)) return null;
  return t;
}

export const DIM_KEYS = ["tech", "expr", "depth", "edge", "reflect"];

/**
 * 五维评分解析 + 数字合法性校验（B2 修复）：LLM 返回字符串或缺维度 → total 不 NaN
 * 每个维度：Number() 转换 + isFinite 校验（非法回退 0）+ 0-100 clamp；合法输入分数不变
 * @param {Record<string, unknown>} rawScores
 * @returns {{ scores: Record<string, number>, total: number }}
 */
export function parseScores(rawScores) {
  const cleanScore = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0; // 字符串/NaN/缺失 → 0（缺维度兜底，不污染 total）
    return Math.min(100, Math.max(0, Math.round(n)));
  };
  const scores = /** @type {Record<string, number>} */ ({});
  for (const d of DIM_KEYS) scores[d] = cleanScore((rawScores || {})[d]);
  const total = Math.round((scores.tech + scores.expr + scores.depth + scores.edge + scores.reflect) / 5);
  return { scores, total };
}

/** 薄弱点回流（有明确 weak_topic 才记录；考察维度名/伪知识点不记）——原题随薄弱点入复习卡 */
export function flowWeakPoint({ weakTopic, total, question }) {
  if (weakTopic && total < 60) {
    memory.addWeakPoint(weakTopic, "模拟面试", "agent", { question: String(question || "").slice(0, 300) });
  }
}

/** 知识点掌握度写回（题目匹配知识点 → 按评分加减分；失败不影响面试主流程） */
export async function recordKpFlow(question, total) {
  try {
    const { matchKp, recordKp } = await import("./knowledge.mjs");
    const kpId = matchKp(question);
    if (kpId) {
      recordKp(kpId, { correct: total >= 60, strong: total >= 80 });
    }
  } catch { /* ignore */ }
}

/** 学习计划事件流埋点（面试每轮进事件流，按 topic 自动归属计划） */
export async function flowLearningEvent({ weakTopic, question, total }) {
  try {
    const { recordLearningEvent } = await import("./learning-plan.mjs");
    const weakName = cleanWeakTopic(weakTopic);
    recordLearningEvent({
      topic: (weakName || String(question || "")).slice(0, 40),
      kind: "interview",
      result: total >= 60 ? "pass" : (total >= 50 ? "partial" : "fail"), // 与薄弱点回流阈值（<60）口径一致
      quality: Math.max(0, Math.min(1, total / 100)),
    });
  } catch { /* 埋点失败不影响面试 */ }
}

/** 结束面试：复习卡 answer 回填（submit 时建的卡 answer 为空）——total<50 轮次用候选人回答回填 */
export async function backfillReviewCards(session) {
  for (const r of session.rounds) {
    if (r.total < 50) {
      const weakTopic = cleanWeakTopic(r.weak_topic);
      if (!weakTopic) continue;
      try {
        const { review } = await import("./review.mjs");
        const card = /** @type {any} */ (review.addCard({
          topic: weakTopic,
          question: String(r.question || "").slice(0, 200),
          answer: String(r.answer || "").slice(0, 300),
          source: "模拟面试",
        }));
        if (card && card.ok === false) console.warn(`[interview-scoring] 复习卡建卡失败: ${card.topic}`);
      } catch { /* ignore */ }
    }
  }
}

/** 结束面试：复盘薄弱知识点 → 追加进学习清单（只取本场实际答错的轮次，why 标注真实来源）
 * @returns {Promise<number>} 新增清单项数
 */
export async function addFailedToPlan(session) {
  let planAdded = 0;
  try {
    const { addPlanItems } = await import("./study.mjs");
    const failedRounds = (session.rounds || []).filter((r) => r.total < 50 && r.weak_topic);
    const items = [];
    for (const r of failedRounds) {
      const t = String(r.weak_topic || "").trim();
      if (!t || items.some((i) => i.topic === t)) continue; // 同知识点去重
      items.push({
        topic: t,
        why: `模拟面试中答错（评分 ${r.total} 分）：${String(r.question || "").slice(0, 40)}`,
        source: "模拟面试",
        verify_question: `请完整回答并讲清原理：${t}`,
        fromInterview: true, // 面试复盘来源 → 面板"面试"徽标
      });
    }
    if (items.length) {
      const r = addPlanItems(items);
      planAdded = r.added || 0;
    }
  } catch { /* ignore */ }
  return planAdded;
}
