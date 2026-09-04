// 学习清单：存储层（study_plan_items 表读写）——只依赖 db
// 纵向拆分第 4 刀第二步
import { randomUUID } from "node:crypto";
import { db, withTx } from "./db.mjs";

// 清单条目 id：时间戳 + 随机后缀，保证同步循环/跨次生成/跨来源都不碰撞
// （旧实现 `s${i+1}` 会在重新生成时与已有条目 id 冲突 → INSERT OR REPLACE 抹掉完成进度）
export function newPlanId() {
  return `s${Date.now().toString(36)}${randomUUID().slice(0, 8)}`;
}

export function loadPlan() {
  const plan = { date: "", items: [] };
  const dateRow = db.prepare("SELECT DISTINCT date FROM study_plan_items ORDER BY date DESC LIMIT 1").get();
  plan.date = String(dateRow?.date || "");
  // 复习卡到期映射（topic → 是否待复习）：面板"待复习/复习到期"分组依赖此字段
  // 修复1：原查询引用不存在的 done 列 → 抛异常被吞 → reviewDue 恒 false → UI 断链
  // 修复2：新卡（从未复习）fsrs_due=0，需按"创建超 1 天"判断到期（与 review.getDueCards 同口径）
  let dueByTopic = new Map();
  try {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const rows = db.prepare("SELECT topic, fsrs_due, created_at FROM review_cards").all();
    for (const r of rows) {
      const due = Number(r.fsrs_due) > 0
        ? Number(r.fsrs_due) <= now                       // 复习过：fsrs_due 到期
        : (Number(r.created_at) || 0) + DAY <= now;       // 新卡：创建超 1 天
      if (due) dueByTopic.set(String(r.topic), true);
    }
  } catch { /* 复习表暂不可用 */ }
  // 也把最近复习过的（reviewed_at 近 3 天）算"不久待复习"？——保持简单：只按到期卡
  plan.items = db.prepare(`SELECT id, topic, why, source, verify_question, done, reviewed, done_at, reviewed_at, level, from_interview, grp
    FROM study_plan_items ORDER BY rowid`).all().map((r) => ({
    id: r.id, topic: r.topic, why: r.why, source: r.source,
    verify_question: r.verify_question,
    done: !!r.done, reviewed: !!r.reviewed,
    doneAt: r.done_at, reviewedAt: r.reviewed_at,
    level: r.level, fromInterview: !!r.from_interview, grp: r.grp || "",
    reviewDue: dueByTopic.has(String(r.topic)),
  }));
  return plan;
}

export function savePlan(plan) {
  // 全量重写：先清空再插入（调用方负责传入合并后的完整 items；generateStudyPlan 已合并保留旧未完成项）
  // 包事务：crash/强杀在 DELETE 与 INSERT 之间不会丢整份清单
  try {
    withTx(() => {
      db.exec("DELETE FROM study_plan_items");
      for (const it of plan.items || []) {
        db.prepare(`INSERT OR REPLACE INTO study_plan_items
          (id, date, topic, why, source, verify_question, done, reviewed, done_at, reviewed_at, level, from_interview, grp, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            String(it.id), String(plan.date || ""), String(it.topic),
            it.why || null, it.source || null, it.verify_question || null,
            it.done ? 1 : 0, it.reviewed ? 1 : 0,
            it.doneAt || null, it.reviewedAt || null,
            it.level || null, it.fromInterview ? 1 : 0, it.grp || "", Date.now()
          );
      }
    });
    return true;
  } catch (e) {
    // 修复 S7：学习清单唯一持久化入口——失败必须可观测（此前静默吞错，用户清单丢失无感知）
    console.error(`[study-store] savePlan 写库失败: ${String(e?.message || e).slice(0, 120)}`);
    return false;
  }
}
