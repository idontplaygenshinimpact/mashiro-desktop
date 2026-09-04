// 长期学习计划引擎（领域无关）：任意"学一段长时间的内容"（算法专项/React 源码/秋招八股…）
// 统一由：计划实体 + 学习事件流 + 趋势聚合 支撑。
// 原则：
//   - 事件表是唯一事实源：任何学习动作 → learning_events 一条（判题/清单/复习自动埋点 + manual 显式记录）
//   - 事件归属：topic 命中计划 scope 关键词 → planId（检测不到归属 → NULL 记为普通学习）
//   - 趋势惰性计算：按时间窗从事件聚合（不预存日报，查询时算，简单且无状态漂移）
//   - 方案调整规则在复盘层（二期），本文件只做数据与基础统计
import { localDateKey } from "./date-utils.mjs";
import { db, withTx } from "./db.mjs";

const PLANS_KEY = "learning_plans"; // settings JSON 数组 [{id,title,scope,quotaPerDay,durationDays,milestones,status,createdAt}]

// ---------- 计划 CRUD ----------
function loadPlans() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key=?").get(PLANS_KEY);
    if (!row?.value) return [];
    const arr = JSON.parse(String(row.value));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function savePlans(plans) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
    .run(PLANS_KEY, JSON.stringify(plans), Date.now());
}

export function newPlanId() {
  return "plan-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/**
 * 创建学习计划：任意长时间学习目标 → 结构化为计划实体
 * @param {object} p { title, scope: string[], quotaPerDay?, durationDays?, milestones? }
 * scope 是事件归属的钥匙（主题词：如 ["二分","链表","DP"] / ["Fiber","调度","渲染"]）
 */
export function createLearningPlan({ title, scope = [], quotaPerDay = 2, durationDays = 30, milestones = [] } = {}) {
  const t = String(title || "").trim();
  if (!t) return { ok: false, error: "计划标题必填" };
  const cleanScope = [...new Set((Array.isArray(scope) ? scope : [])
    .map((s) => String(s || "").trim().toLowerCase()).filter(Boolean))];
  if (!cleanScope.length) return { ok: false, error: `计划范围必填（scope 主题词，如 ["二分","链表"]）——它是自动归类学习记录的钥匙` };
  const plan = {
    id: newPlanId(),
    title: t,
    scope: cleanScope,
    quotaPerDay: Math.max(1, Number(quotaPerDay) || 2),
    durationDays: Math.max(1, Number(durationDays) || 30),
    milestones: Array.isArray(milestones) ? milestones.map((m) => String(m || "").trim()).filter(Boolean) : [],
    status: "active",
    createdAt: Date.now(),
  };
  const plans = loadPlans();
  plans.push(plan);
  savePlans(plans);
  return { ok: true, plan };
}

/** 列出全部计划（active 在前） */
export function getLearningPlans() {
  return loadPlans().sort((a, b) => (a.status === b.status ? (b.createdAt - a.createdAt) : (a.status === "active" ? -1 : 1)));
}

/** topic → 归属计划 id（scope 子串匹配；未命中 null） */
export function matchPlanForTopic(topic) {
  const t = String(topic || "").toLowerCase();
  if (!t) return null;
  for (const p of loadPlans()) {
    if (p.status !== "active") continue;
    for (const kw of p.scope) {
      if (t.includes(kw)) return p.id;
    }
  }
  return null;
}

// ---------- 事件流 ----------
/** 记录一条学习事件（自动埋点与 manual 共用；planId 缺省按 topic 自动归属）
 * @param {{topic: string, kind?: string, result?: string|null, quality?: number|null, durationMs?: number|null, planId?: string|null, ts?: number}} e
 * @returns {{ok: boolean, error?: string, planId?: string|null}} */
export function recordLearningEvent({ topic, kind, result = null, quality = null, durationMs = null, planId = null, ts = Date.now() }) {
  const t = String(topic || "").trim();
  if (!t) return { ok: false, error: "topic 必填" };
  const pid = planId || matchPlanForTopic(t);
  const q = quality === null ? null : Math.max(0, Math.min(1, Number(quality) || 0));
  db.prepare(
    "INSERT INTO learning_events (plan_id, topic, kind, result, quality, duration_ms, ts) VALUES (?,?,?,?,?,?,?)"
  ).run(pid, t, String(kind || "manual").slice(0, 30), result ? String(result).slice(0, 10) : null, q,
    durationMs === null ? null : Number(durationMs) || 0, Number(ts) || Date.now());
  return { ok: true, planId: pid };
}

// ---------- 通用即时反馈（与动作类型解耦） ----------
/**
 * 事件产生后的即时反馈提示（判题/复习/清单/手动记录统一走这里——不按内容类型改调度）。
 * 素材全部来自事件流基线对比：
 *   a. 同 kind 且同 topic 的历史事件（自己这条线的进步/退步）
 *   b. 同 kind 全体事件（该动作类型的平均节奏）
 *   c. 当前计划当日配额达成度
 * @param {{topic: string, kind: string, result?: string|null, quality?: number|null, durationMs?: number|null, planId?: string|null, now?: number}} e
 * @returns {string|null} 提示文案（无基线/无对比意义时 null）
 */
export function buildFeedbackTip({ topic, kind, result = null, quality = null, durationMs = null, planId = null, now = Date.now() }) {
  const t = String(topic || "").trim();
  if (!t) return null;
  const k = String(kind || "manual");
  const tips = [];

  // 需要 planId（未归属计划的动作：仅当"历史失败过且本次转正"才提示——不打扰普通学习）
  const pid = planId || matchPlanForTopic(t);
  if (!pid) {
    const badBefore = (() => {
      try {
        const row = db.prepare(
          "SELECT COUNT(*) n FROM learning_events WHERE topic=? AND (result IN ('fail','partial') OR (quality IS NOT NULL AND quality < 0.5))"
        ).get(t);
        return Number(row?.n || 0) > 0;
      } catch { return false; }
    })();
    const nowGood = result === "pass" || (quality !== null && Number(quality) >= 0.6);
    return badBefore && nowGood ? `✅ 这个知识点你之前表现不佳，这次转正了——薄弱点已修复` : null;
  }

  // a) 同 kind + 同 topic 历史（这个知识点自己的历史：这题/这门课之前的表现）
  const ownRows = db.prepare(
    "SELECT result, quality, duration_ms, ts FROM learning_events WHERE kind=? AND topic=? AND ts < ? ORDER BY ts"
  ).all(k, t, now);
  // b) 同 kind 全体基线
  const kindAvg = db.prepare(
    "SELECT AVG(duration_ms) avg_ms FROM learning_events WHERE kind=? AND duration_ms IS NOT NULL"
  ).get(k);

  // 节奏对比（有耗时且该 kind 有基线时）
  if (durationMs && kindAvg?.avg_ms) {
    const avg = Number(kindAvg.avg_ms);
    const mine = Number(durationMs);
    if (avg > 0 && mine > 0) {
      const ratio = Math.round(mine / avg * 100);
      if (ratio >= 150) tips.push(`⏱ 这次 ${Math.round(mine / 1000)}s，同类动作平均 ${Math.round(avg / 1000)}s——慢了 ${ratio - 100}%，先想清楚再做`);
      else if (ratio <= 60) tips.push(`⏱ 这次 ${Math.round(mine / 1000)}s，明显快于同类平均（${ratio}%）——节奏很好`);
    }
  }
  // 自己的历史对比（有 prior 记录才提示）
  if (ownRows.length >= 1 && durationMs) {
    const prev = ownRows.filter((r) => r.duration_ms).pop();
    if (prev?.duration_ms) {
      const prevMs = Number(prev.duration_ms);
      if (prevMs > 0) {
        const delta = Math.round((Number(durationMs) - prevMs) / 1000);
        if (Math.abs(delta) >= 3) tips.push(delta > 0 ? `📉 比上次慢 ${delta}s（上次 ${Math.round(prevMs / 1000)}s）` : `📈 比上次快 ${-delta}s（上次 ${Math.round(prevMs / 1000)}s）`);
      }
    }
  }
  // 转正提示：同 topic 历史上失败/低质量 ≥1 次，本次 pass/高质量
  const badBefore = ownRows.some((r) => r.result === "fail" || r.result === "partial" || (r.quality !== null && Number(r.quality) < 0.5));
  const nowGood = result === "pass" || (quality !== null && Number(quality) >= 0.6);
  if (badBefore && nowGood) tips.push(`✅ 这个知识点你之前表现不佳，这次转正了——薄弱点已修复`);

  // 计划配额达成（今日已做 vs 配额）
  try {
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const todayN = db.prepare("SELECT COUNT(*) n FROM learning_events WHERE plan_id=? AND ts >= ?").get(pid, dayStart.getTime()).n;
    const plans = loadPlans();
    const plan = plans.find((p) => p.id === pid);
    if (plan) {
      const quota = Number(plan.quotaPerDay) || 0;
      const n = Number(todayN) || 0;
      if (quota > 0 && n === quota) tips.push(`🎯 今日达标 ${n}/${quota}——完成当日目标`);
      else if (quota > 0) tips.push(`📋 今日 ${n}/${quota}`);
    }
  } catch { /* ignore */ }

  return tips.length ? tips.join("；") : null;
}

/** 未归属计划的动作：有"转正"意义才提示（历史失败过且本次通过） */
// ---------- 趋势聚合（惰性计算） ----------
/**
 * 计划状态：进度 + 趋势（按天聚合事件）
 * @param {string} [planId]
 * @returns {{ok: boolean, error?: string, plan?: object, status?: object}}
 */
export function getLearningPlanStatus(planId) {
  const plans = loadPlans();
  // 缺省：最近激活的计划（按 createdAt 新 → 旧）
  const active = plans.filter((p) => p.status === "active").sort((a, b) => b.createdAt - a.createdAt);
  const plan = (planId ? plans.find((p) => p.id === planId) : null) || active[0] || null;
  if (!plan) return { ok: false, error: "还没有学习计划——对话里说'建一个XX计划'即可创建" };

  const rows = db.prepare(
    `SELECT topic, result, quality, duration_ms, ts FROM learning_events WHERE plan_id=? ORDER BY ts`
  ).all(plan.id);

  // 按天聚合（本地日期）
  const dayMs = 24 * 3600 * 1000;
  const byDay = new Map();
  for (const r of rows) {
    const key = localDateKey(Number(r.ts)); // 天粒度（UTC 简化——够用）
    const d = byDay.get(key) || { done: 0, pass: 0, durationMs: 0, results: [] };
    d.done++;
    if (r.result === "pass" || (r.quality !== null && Number(r.quality) >= 0.6)) d.pass++;
    if (r.duration_ms) d.durationMs += Number(r.duration_ms);
    if (r.result) d.results.push(String(r.result));
    byDay.set(key, d);
  }
  const trend = [...byDay.entries()].map(([date, d]) => ({
    date,
    done: d.done,
    passRate: d.done ? Math.round(d.pass / d.done * 100) : 0,
    avgMs: d.done ? Math.round(d.durationMs / d.done) : 0,
  })).sort((a, b) => a.date.localeCompare(b.date));

  // 质量薄弱主题（结果 fail/partial 或低 quality 的 topic 聚合）
  const weakMap = new Map();
  for (const r of rows) {
    const bad = r.result === "fail" || r.result === "partial" || (r.quality !== null && Number(r.quality) < 0.5);
    if (!bad) continue;
    weakMap.set(r.topic, (weakMap.get(r.topic) || 0) + 1);
  }
  const weakTopics = [...weakMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);

  const doneTotal = rows.length;
  const passed = rows.filter((r) => r.result === "pass" || (r.quality !== null && Number(r.quality) >= 0.6)).length;
  const days = trend.length;
  const activeDays = rows.length ? new Set(rows.map((r) => localDateKey(Number(r.ts)))).size : 0;
  const now = Date.now();
  const todayKey = localDateKey(now);
  const today = byDay.get(todayKey);
  const elapsedDays = Math.max(1, Math.ceil((now - plan.createdAt) / dayMs));

  return {
    ok: true,
    plan: { ...plan, elapsedDays, remainDays: Math.max(0, plan.durationDays - elapsedDays) },
    status: {
      days, activeDays, doneTotal,
      passRate: doneTotal ? Math.round(passed / doneTotal * 100) : 0,
      avgMs: doneTotal ? Math.round(rows.reduce((s, r) => s + (Number(r.duration_ms) || 0), 0) / doneTotal) : 0,
      todayDone: today?.done || 0,
      todayQuota: plan.quotaPerDay,
      trend: trend.slice(-14),
      weakTopics,
    },
  };
}