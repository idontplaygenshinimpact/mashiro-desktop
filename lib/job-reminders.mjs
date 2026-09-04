// 岗位提醒与日程同步（从 jobs.mjs 拆出——职责分离：岗位数据层 vs 截止/笔试提醒）
// 职责：3 天内截止/笔试筛选（纯函数）· 笔试时间同步到日程表（schedule_events）
import { db } from "./db.mjs";
import { parseLocalDate } from "./date-utils.mjs"; // 技术债 L2：收敛单点

/** 岗位笔试时间同步进日程表（schedule_events，邮箱邀约同表）——笔试进入统一日程，提前提醒 */
export function syncJobBishiToSchedule(id, company, title, bishiDate) {
  if (!id || !company || !bishiDate) return;
  try {
    // 本地时区解析（纯日期 → 当天 00:00，带时间 → 精确；修复 UTC +8h 漂移）
    const t = parseLocalDate(bishiDate);
    if (Number.isNaN(t)) return;
    // UPSERT（email_id 索引已降级为普通索引，无 UNIQUE 约束 → 显式先查后改/插，语义不变：
    // 笔试时间变更时更新日程（修复：原 INSERT OR IGNORE 只增不更新 → 变更后提醒错时））
    // 注意：schedule_events 无 updated_at 列（仅 created_at），更新不改 created_at
    const emailId = `job_${String(id)}`;
    const cleanCompany = String(company).slice(0, 60);
    const cleanTitle = String(title || "").slice(0, 60);
    const existing = db.prepare("SELECT id FROM schedule_events WHERE email_id = ?").get(emailId);
    if (existing) {
      db.prepare("UPDATE schedule_events SET company = ?, role = ?, interview_at = ? WHERE id = ?")
        .run(cleanCompany, cleanTitle, t, existing.id);
    } else {
      db.prepare(
        `INSERT INTO schedule_events (company, role, interview_at, form, location, link, email_id, created_at)
         VALUES (?, ?, ?, '笔试', '', '', ?, ?)`
      ).run(cleanCompany, cleanTitle, t, emailId, Date.now());
    }
  } catch { /* 日程表暂不可用忽略 */ }
}

/**
 * 筛选 3 天内即将截止/笔试的未完成岗位（纯函数，供提醒定时器与测试复用）
 * @param {Array} jobs 岗位列表（getJobs 返回形状）
 * @param {number} [now] 当前时间戳（测试注入用；默认 Date.now()）
 * @returns {Array<{id:string, company:string, title:string, deadline:string|null, bishiDate:string|null, dueDate:string, kind:string}>}
 */
export function getUpcomingJobDeadlines(jobs, now = Date.now()) {
  const upcoming = [];
  // 日历日比较（本地时区日期字符串）：截止/笔试当天 0 点一过，时间戳差 diff=t-now 变负，
  // 原 diff>=0 过滤会让当天到期岗位全天无提醒 → 改为"今天"与到期日两个日期字符串的天数差 ∈ [0,3]
  const d = new Date(now);
  const todayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  for (const j of jobs || []) {
    if (!j || j.status === "done") continue; // 已完成不提醒
    const candidates = [
      { date: j.deadline, kind: "截止" },
      { date: j.bishiDate, kind: "笔试" },
    ];
    for (const { date, kind } of candidates) {
      if (!date) continue;
      const t = parseLocalDate(date);
      if (Number.isNaN(t)) continue; // 非法/空日期跳过
      // 到期日取本地日历日（带时间日期也只看日期部分）
      const dd = new Date(t);
      const dueKey = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(dd.getDate()).padStart(2, "0")}`;
      const [y1, m1, d1] = todayKey.split("-").map(Number);
      const [y2, m2, d2] = dueKey.split("-").map(Number);
      const diffDays = Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
      if (diffDays >= 0 && diffDays <= 3) {
        upcoming.push({ id: j.id, company: j.company, title: j.title, deadline: j.deadline, bishiDate: j.bishiDate, dueDate: String(date), kind });
        break; // 同岗位截止与笔试都临近时只提醒一次（取靠前者）
      }
    }
  }
  return upcoming;
}
