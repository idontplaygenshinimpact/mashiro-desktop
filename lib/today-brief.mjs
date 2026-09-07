// 今日任务视图工单：聚合"今天该做什么"——桌宠每日播报 + 面板聚合卡共用同一数据源
// 数据源（不重复实现）：getLearningPlanStatus（今日配额）+ review 到期卡 + 薄弱点 + 清单未完成
import { getLearningPlanStatus } from "./learning-plan.mjs";
import { memory } from "./memory.mjs";
import { getPlan } from "./study.mjs";
import { review } from "./review.mjs";

/**
 * 今日任务聚合：计划配额进度 / 到期卡 / 薄弱点 / 清单未完成
 * @returns {{ok: boolean, plan: {hasPlan: boolean, title?: string, todayDone: number, todayQuota: number}, reviewDue: number, weakCount: number, planTodo: number, text: string}}
 */
export function buildTodayBrief() {
  // ① 学习计划今日配额（缺省最近激活计划）
  let plan = { hasPlan: false, todayDone: 0, todayQuota: 0 };
  try {
    const st = getLearningPlanStatus();
    if (st.ok) {
      plan = {
        hasPlan: true,
        title: String(st.plan?.title || ""),
        todayDone: Number(st.status?.todayDone) || 0,
        todayQuota: Number(st.status?.todayQuota) || 0,
      };
    }
  } catch { /* 计划引擎异常不影响聚合 */ }
  // ② 复习卡到期
  let reviewDue = 0;
  try { reviewDue = review.getDueCards().length; } catch { /* ignore */ }
  // ③ 薄弱点（可信源）
  let weakCount = 0;
  try { weakCount = memory.getTrustedWeakPoints(100).length; } catch { /* ignore */ }
  // ④ 清单未完成
  let planTodo = 0;
  try { planTodo = (getPlan().items || []).filter((i) => !i.done).length; } catch { /* ignore */ }
  return { ok: true, plan, reviewDue, weakCount, planTodo, text: buildBriefText({ plan, reviewDue, weakCount, planTodo }) };
}

/**
 * 播报文案："今天计划还有 N 个单元 · 复习卡到期 M 张 · 薄弱点 K 个待消灭 · 建议来一轮模拟面试"
 * @param {{plan?: object, reviewDue?: number, weakCount?: number, planTodo?: number}} d
 * @returns {string}
 */
export function buildBriefText({ plan, reviewDue = 0, weakCount = 0, planTodo = 0 } = {}) {
  const parts = [];
  if (plan?.hasPlan) {
    const remain = Math.max(0, (Number(plan.todayQuota) || 0) - (Number(plan.todayDone) || 0));
    parts.push(remain > 0 ? `今天计划还有 ${remain} 个单元（${plan.todayDone}/${plan.todayQuota}）` : `今天计划已完成（${plan.todayDone}/${plan.todayQuota}）`);
  }
  if (reviewDue > 0) parts.push(`复习卡到期 ${reviewDue} 张`);
  if (weakCount > 0) parts.push(`薄弱点 ${weakCount} 个待消灭`);
  if (planTodo > 0) parts.push(`清单还有 ${planTodo} 项未完成`);
  if (!parts.length) return "今天没有到期任务——保持节奏，来一轮模拟面试巩固？";
  return `📅 今日任务：${parts.join(" · ")} · 建议来一轮模拟面试`;
}
