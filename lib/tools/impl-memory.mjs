// 工具实现组：记忆/个人数据（纵向拆分第 3 刀）
// toolGetMemoryExpanded / toolRemember
import { memory } from "../memory.mjs";

/**
 * 获取记忆展开（画像/关注点/薄弱点/掌握度全量）
 * @returns {Promise<{profile: string, interests: string[], mastered: string[], [k: string]: any}>} 记忆数据（含扩展字段）
 */
export async function toolGetMemoryExpanded() {
  // 基础画像（关注点/薄弱点/目标）
  const base = {
    profile: memory.getProfileSummary(),
    interests: memory.getInterests(),
    mastered: memory.getMastered().slice(-10),
  };
  // 顺带带出关键个人数据（简历摘要 + 推荐岗位 top3 + 最近日程）——对话上下文直接可见
  try {
    const { getResumeRaw } = await import("../job-match.mjs");
    const raw = getResumeRaw ? getResumeRaw() : null;
    if (raw) base.resume = (raw && typeof raw === "object" ? JSON.stringify(raw) : String(raw ?? "")).slice(0, 1500);
  } catch { /* ignore */ }
  try {
    const { getRecommendedJobs } = await import("../job-match.mjs");
    const rec = getRecommendedJobs ? getRecommendedJobs(3) : [];
    base.recommendedJobs = (Array.isArray(rec) ? rec : []).map((j) => {
      const jd = /** @type {any} */ (j);
      return { company: jd.company, title: jd.title, match: jd.matchScore ?? jd.match, deadline: jd.deadline };
    });
  } catch { /* ignore */ }
  try {
    const { getSchedule } = await import("../mail.mjs");
    const ev = getSchedule ? getSchedule() : [];
    base.upcomingSchedule = (Array.isArray(ev) ? ev : []).slice(0, 3).map((e) => ({ company: e.company, role: e.role, at: e.interviewAt, form: e.form }));
  } catch { /* ignore */ }
  return base;
}

/**
 * 记录长期记忆（用户显式要求记住的内容）
 * @param {string[]} topics 要记住的知识点
 * @returns {Promise<{ok: boolean, added: any, interests: string[]}>} 记录结果
 */
export async function toolRemember(topics) {
  const added = memory.addInterests(topics || []);
  return { ok: true, added, interests: memory.getInterests() };
}
