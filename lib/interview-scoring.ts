// 模拟面试：STaR 解析 + 五维评分校验 + 薄弱点/复习卡/掌握度回流
// 纵向拆分第 5 刀：interview-scoring 域
import { memory } from "./memory.mjs";

// 伪知识点过滤统一（工单任务 4）：委托 memory._cleanTopic（单一实现）——
// 此前两套独立模式（本文件 PSEUDO_PATTERNS 40 字 vs memory._cleanTopic 30 字+更全模式）
// 会漂移（如"题1【…】"题目占位符/测试残留"到期新卡"只在 _cleanTopic 拦）。
// 统一用 _cleanTopic：30 字截断 + 全量模式（考察维度/泛化标签/题目占位符/无实质内容）。
export function cleanWeakTopic(topic: unknown): string | null {
  return memory._cleanTopic ? memory._cleanTopic(topic) : null;
}

export const DIM_KEYS: string[] = ["tech", "expr", "depth", "edge", "reflect"];

/** 面试轮次（backfillReviewCards/addFailedToPlan 消费的最小形状） */
export interface InterviewRoundLike {
  total?: number;
  weak_topic?: unknown;
  question?: unknown;
  answer?: unknown;
}

/** 会话最小形状（rounds 为复盘来源——可缺省，调用方已保证进行中的会话有轮次） */
export interface SessionLike {
  rounds?: InterviewRoundLike[];
}

/**
 * 五维评分解析 + 数字合法性校验（B2 修复）：LLM 返回字符串或缺维度 → total 不 NaN
 * 每个维度：Number() 转换 + isFinite 校验（非法回退 0）+ 0-100 clamp；合法输入分数不变
 */
export function parseScores(rawScores: Record<string, unknown> | null | undefined): { scores: Record<string, number>; total: number } {
  const cleanScore = (v: unknown): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0; // 字符串/NaN/缺失 → 0（缺维度兜底，不污染 total）
    return Math.min(100, Math.max(0, Math.round(n)));
  };
  const scores: Record<string, number> = {};
  for (const d of DIM_KEYS) scores[d] = cleanScore((rawScores || {})[d]);
  const total = Math.round((scores.tech + scores.expr + scores.depth + scores.edge + scores.reflect) / 5);
  return { scores, total };
}

/** 薄弱点回流（有明确 weak_topic 才记录；考察维度名/伪知识点不记）——原题随薄弱点入复习卡
 * 阈值分层决策（工单任务 2，统一口径）：
 *   - total < 60 → 薄弱点（flowWeakPoint 本函数）——"部分掌握"也回流，靠复习卡补
 *   - total < 50 → 薄弱点 + 学习清单（addFailedToPlan）——明确答错，强信号直接进清单
 *   - 50-59（partial）只进薄弱点不进清单：一次"半会不会"就进清单会堆满低质量条目；
 *     反复 partial 会经薄弱点 fail_count≥2 自动入清单（薄弱点闭环工单）——分层闭环完整
 * 与 learning_events 口径一致：>=60 pass / >=50 partial / <50 fail */
export function flowWeakPoint({ weakTopic, total, question }: { weakTopic?: unknown; total: number; question?: unknown }): void {
  if (weakTopic && total < 60) {
    memory.addWeakPoint(weakTopic, "模拟面试", "agent", { question: String(question || "").slice(0, 300) });
  }
}

/** 知识点掌握度写回（题目匹配知识点 → 按评分加减分；失败不影响面试主流程） */
export async function recordKpFlow(question: unknown, total: number): Promise<void> {
  try {
    const { matchKp, recordKp } = await import("./knowledge.ts");
    const kpId = matchKp(question);
    if (kpId) {
      recordKp(kpId, { correct: total >= 60, strong: total >= 80 });
    }
  } catch { /* ignore */ }
}

/** 学习计划事件流埋点（面试每轮进事件流，按 topic 自动归属计划） */
export async function flowLearningEvent({ weakTopic, question, total }: { weakTopic?: unknown; question?: unknown; total: number }): Promise<void> {
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
export async function backfillReviewCards(session: SessionLike): Promise<void> {
  for (const r of session.rounds || []) {
    if ((r.total ?? 0) < 50) {
      const weakTopic = cleanWeakTopic(r.weak_topic);
      if (!weakTopic) continue;
      try {
        const { review } = await import("./review.mjs");
        const card = review.addCard({
          topic: weakTopic,
          question: String(r.question || "").slice(0, 200),
          answer: String(r.answer || "").slice(0, 300),
          source: "模拟面试",
        });
        if (card && "ok" in card && card.ok === false) console.warn(`[interview-scoring] 复习卡建卡失败: ${card.topic}`);
      } catch { /* ignore */ }
    }
  }
}

/** 结束面试：复盘薄弱知识点 → 追加进学习清单（只取本场实际答错的轮次，why 标注真实来源）
 * 阈值分层（工单任务 2）：total < 50（明确答错）才进清单；50-59 只进薄弱点（flowWeakPoint），
 * 反复 partial 经薄弱点 fail_count≥2 自动入清单——分层闭环，不堆低质量条目
 * @returns 新增清单项数
 */
export async function addFailedToPlan(session: SessionLike): Promise<number> {
  let planAdded = 0;
  try {
    const { addPlanItems } = await import("./study.mjs");
    const failedRounds = (session.rounds || []).filter((r) => (r.total ?? 0) < 50 && r.weak_topic);
    const items: Array<{ topic: string; why: string; source: string; verify_question: string; fromInterview: boolean }> = [];
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
