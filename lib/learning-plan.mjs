// 长期学习计划引擎（领域无关）：任意"学一段长时间的内容"（算法专项/React 源码/秋招八股…）
// 统一由：计划实体 + 学习事件流 + 趋势聚合 支撑。
// 原则：
//   - 事件表是唯一事实源：任何学习动作 → learning_events 一条（判题/清单/复习自动埋点 + manual 显式记录）
//   - 事件归属：topic 命中计划 scope 关键词 → planId（检测不到归属 → NULL 记为普通学习）
//   - 趋势惰性计算：按时间窗从事件聚合（不预存日报，查询时算，简单且无状态漂移）
//   - 方案调整规则在复盘层（二期），本文件只做数据与基础统计
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
    const key = new Date(Number(r.ts)).toISOString().slice(0, 10); // 天粒度（UTC 简化——够用）
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
  const activeDays = rows.length ? new Set(rows.map((r) => new Date(Number(r.ts)).toISOString().slice(0, 10))).size : 0;
  const now = Date.now();
  const todayKey = new Date(now).toISOString().slice(0, 10);
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