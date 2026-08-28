// 模拟面试：优先考察内容聚合（6 源闭环：练习/复习/清单数据自动进入面试）
// 纵向拆分第 5 刀：interview-focus 域
// 用户"近期做了什么"自动成为面试官优先考察方向——不需要手动选重点：
//   1) 薄弱点（failCount 高）——来自模拟面试/复盘/题库错题回流
//   2) 题库错题（wrong_count>0 的算法/手写题）
//   3) 复习卡答错 ≥2 次的错题本
//   4) 今日复习过的主题（"复习完 → 面试检验"闭环）
//   5) 到期复习卡（该复习还没复习的）
//   6) 学习清单未完成项
// 全部去重合并（同 topic 取最高优先级来源），按"优先级分 + 最近时间"排序
import { memory } from "./memory.mjs";

export async function buildInterviewFocus() {
  const byTopic = new Map(); // topic -> { topic, reason, score }（同 topic 取最高分来源）
  const add = (topic, reason, score) => {
    const t = String(topic || "").trim().slice(0, 40);
    if (!t) return;
    const clean = memory._cleanTopic ? memory._cleanTopic(t) : t;
    if (!clean) return;
    const cur = byTopic.get(clean);
    if (!cur || score > cur.score) byTopic.set(clean, { topic: clean, reason, score });
    else if (score === cur.score) cur.reason += `；${reason}`;
  };

  // 1) 薄弱点（failCount 越高越优先）
  try {
    for (const w of memory.getTrustedWeakPoints(10)) add(w.topic, `薄弱点（答错 ${w.failCount || 1} 次）`, 100 + (w.failCount || 1));
  } catch { /* ignore */ }
  // 2) 题库错题（wrong_count>0，算法/手写专项练习）
  try {
    const { getChallenges } = await import("./ai-career.mjs");
    for (const c of getChallenges()) {
      if (c.wrongCount > 0 && !c.done) add(c.title, `题库练习答错 ${c.wrongCount} 次（${c.category === "handwrite" ? "手写" : "算法"}题）`, 80 + Math.min(c.wrongCount, 10));
    }
  } catch { /* ignore */ }
  // 3) 复习卡错题本（答错 ≥2 次）
  try {
    const { review } = await import("./review.mjs");
    for (const c of review.getWrongCards(6)) add(c.topic, `复习反复答错 ${c.wrongCount} 次`, 90 + Math.min(Number(c.wrongCount) || 0, 10));
  } catch { /* ignore */ }
  // 4) 今日复习过的主题（"复习完 → 面试检验"——刚复习的趁热考）
  try {
    const { review } = await import("./review.mjs");
    for (const c of review.getTodayReviewedTopics()) add(c.topic, "今日刚复习（趁热检验）", 60);
  } catch { /* ignore */ }
  // 5) 到期复习卡（该复习未复习）
  try {
    const { review } = await import("./review.mjs");
    for (const c of review.getDueCards().slice(0, 6)) add(c.topic, "复习卡已到期（欠复习）", 70);
  } catch { /* ignore */ }
  // 6) 学习清单未完成项
  try {
    const { getPlan } = await import("./study.mjs");
    for (const i of (getPlan().items || [])) {
      if (!i.done) add(i.topic, "学习清单未完成", 50);
    }
  } catch { /* ignore */ }

  return [...byTopic.values()].sort((a, b) => b.score - a.score).slice(0, 12);
}
