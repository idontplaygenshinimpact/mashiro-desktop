// 专注监督（番茄钟）：开始专注 → 桌宠陪伴 → 分心检测提醒 → 到点自动完成 → 自动进入休息
// 数据：focus_sessions 表（db.mjs schema + goal 列迁移）+ settings 表 focus_blacklist/focus_whitelist/focus_config
// 设计：本模块不依赖 widget/electron，纯 node:sqlite + 纯函数，可独立单元测试
// 状态机：idle → focusing（专注）→ resting（休息）→ idle
//   到期惰性处理（sweepExpired）：任何状态查询时发现到点自动流转，不依赖定时器
import { db } from "./db.mjs";
import { memory } from "./memory.mjs";

// 分心黑名单默认值（命中前台窗口标题/进程名即视为分心，大小写不敏感）
export const DEFAULT_BLACKLIST = [
  "哔哩哔哩", "bilibili", "Steam", "原神", "抖音", "YouTube",
  "Netflix", "爱奇艺", "腾讯视频", "斗鱼", "虎牙",
  "进程名:WeChat.exe", "进程名:QQ.exe", "进程名:Telegram.exe",
];

// 默认白名单（命中 → 不报分心；如 IDE/浏览器学习页面）
export const DEFAULT_WHITELIST = [
  "进程名:Code.exe", "进程名:electron.exe", "进程名:chrome.exe", "进程名:msedge.exe",
  "进程名:WeChatDevTools.exe",
];

// focus_sessions 表加 goal 列（幂等迁移；新库建表时已有）
try { db.exec("ALTER TABLE focus_sessions ADD COLUMN goal TEXT"); } catch { /* 列已存在 */ }

// 重启结算：模块级 session 是内存态，进程重启后 DB 里 ended_at IS NULL 的"进行中"会话永远滞留
// （统计/面板出现永不结束的会话）→ 模块加载时统一标记为中断（completed=0，ended_at=当前时间）
try {
  db.prepare("UPDATE focus_sessions SET ended_at = ?, completed = 0 WHERE ended_at IS NULL").run(Date.now());
} catch { /* 表暂不可用 → 忽略 */ }

// ---------- 模块级会话状态（单进程内唯一进行中会话） ----------
let session = null;   // {phase:"focusing"|"resting", sessionId, mode, goal, startedAt, endAt, distracts, restEndAt}
let lastStop = null;  // {completed, durationMinutes, phase, goal, restDone} 上次结束结果（供 getFocusStatus 告知完成态）

// 时长模式 → 分钟；休息时长（可配，默认 5 分钟）
const MODES = { "25": 25, "45": 45 };
const REST_DEFAULT_MINUTES = 5;

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---------- settings 读写 ----------
function readSetting(key, fallback) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row && row.value != null ? String(row.value) : fallback;
  } catch { /* settings 表暂不可用时走默认值 */ }
  return fallback;
}
function writeSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(key, String(value), Date.now());
}

// ---------- 分心黑名单 / 白名单 ----------
export function getBlacklist() {
  try {
    const raw = readSetting("focus_blacklist", "");
    if (!raw) return [...DEFAULT_BLACKLIST];
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return list.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    }
  } catch { /* 解析失败回退默认 */ }
  return [...DEFAULT_BLACKLIST];
}

export function getWhitelist() {
  try {
    const raw = readSetting("focus_whitelist", "");
    if (!raw) return [...DEFAULT_WHITELIST];
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return list.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim());
    }
  } catch { /* 解析失败回退默认 */ }
  return [...DEFAULT_WHITELIST];
}

export function setBlacklist(list) {
  if (!Array.isArray(list)) return { ok: false, error: "blacklist 必须是数组" };
  const clean = [...new Set(list.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))];
  try {
    writeSetting("focus_blacklist", JSON.stringify(clean));
    return { ok: true, blacklist: clean };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function setWhitelist(list) {
  if (!Array.isArray(list)) return { ok: false, error: "whitelist 必须是数组" };
  const clean = [...new Set(list.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))];
  try {
    writeSetting("focus_whitelist", JSON.stringify(clean));
    return { ok: true, whitelist: clean };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 分心匹配（纯函数） ----------
// 黑名单项支持三种形式：
//   普通关键词          → 标题包含（如 "bilibili"）
//   进程名:Xxx.exe      → 前台进程名匹配（如 "进程名:WeChat.exe"）
//   /正则/              → 标题正则匹配（如 "/抖音|快手/"）
export function matchRule(rule, { title, processName }) {
  const r = String(rule || "").trim();
  if (!r) return false;
  const t = String(title || "").toLowerCase();
  const p = String(processName || "").toLowerCase();
  // 进程名规则
  const pm = r.match(/^进程名[:：]\s*(.+)$/i);
  if (pm) return p.includes(pm[1].trim().toLowerCase());
  // 正则规则
  const rm = r.match(/^\/(.+)\/([a-z]*)$/i);
  if (rm) {
    try { return new RegExp(rm[1], rm[2] || "i").test(String(title || "")); } catch { return false; }
  }
  // 普通关键词：标题包含
  return t.includes(r.toLowerCase());
}

/**
 * 综合分心判断：白名单优先（命中 → 不报），再查黑名单
 * @param {{title?: any, processName?: any}} info 前台窗口信息
 * @param {string[]} [blacklist]
 * @param {string[]} [whitelist]
 * @returns {{distracting: boolean, rule?: string, reason?: string}}
 */
export function isDistracting({ title, processName }, blacklist, whitelist) {
  const info = { title: String(title || ""), processName: String(processName || "") };
  if (Array.isArray(whitelist)) {
    for (const w of whitelist) {
      if (matchRule(w, info)) return { distracting: false, reason: `白名单命中: ${w}` };
    }
  }
  const list = Array.isArray(blacklist) ? blacklist : [];
  for (const kw of list) {
    if (matchRule(kw, info)) return { distracting: true, rule: kw };
  }
  return { distracting: false };
}

/** 兼容旧签名：仅标题 + 黑名单（桌面监督旧路径/测试） */
export function isDistractingTitle(title, blacklist) {
  return isDistracting({ title }, blacklist, []).distracting;
}

// ---------- 专注会话状态机 ----------

/** 惰性到期流转：专注到点 → 自动完成 + 进入休息；休息到点 → 自动结束。
 *  返回流转事件（无则 null）："focus-done" | "rest-done" */
function sweepExpired(now = Date.now()) {
  if (!session) return null;
  if (session.phase === "focusing" && now >= session.endAt) {
    const goal = session.goal;
    db.prepare("UPDATE focus_sessions SET ended_at = ?, completed = 1, distracts = ? WHERE id = ?")
      .run(now, session.distracts, session.sessionId);
    // 目标回流学习进度（专注完成 = 该知识点过了一遍）
    if (goal) {
      try { memory.recordProgress(goal, "reviewed"); } catch { /* 回流失败不影响状态流转 */ }
    }
    const restMinutes = Number.isFinite(Number(session.restMinutes)) ? Math.min(Math.max(Number(session.restMinutes), 1), 30) : REST_DEFAULT_MINUTES;
    lastStop = {
      completed: true,
      durationMinutes: MODES[session.mode] || 25,
      phase: "focusing",
      goal: goal || null,
    };
    session = { phase: "resting", sessionId: null, mode: null, goal: goal || null, startedAt: now, endAt: null, distracts: 0, restMinutes, restEndAt: now + restMinutes * 60 * 1000 };
    return "focus-done";
  }
  if (session.phase === "resting" && now >= session.restEndAt) {
    lastStop = { ...(lastStop || {}), completed: true, phase: "resting", restDone: true };
    session = null;
    return "rest-done";
  }
  return null;
}

/**
 * 开始专注：mode=25/45；goal 可选（本次专注目标，完成时回流学习进度）；restMinutes 可选（休息时长，默认 5）
 * @param {string} mode
 * @param {{goal?: string, restMinutes?: number}} [opts]
 */
export function startFocus(mode, { goal = "", restMinutes } = {}) {
  sweepExpired();
  const m = String(mode || "");
  if (!MODES[m]) return { ok: false, error: "mode 必须是 25 或 45" };
  if (session) {
    if (session.phase === "resting") {
      // 休息中直接开始下一轮：结束休息
      session = null;
    } else {
      return { ok: false, error: "已有进行中的专注，先结束再开始" };
    }
  }
  const now = Date.now();
  const endAt = now + MODES[m] * 60 * 1000;
  const cleanGoal = String(goal || "").trim().slice(0, 60) || null;
  const info = db.prepare(
    `INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at, goal)
     VALUES (?, ?, NULL, 0, 0, ?, ?)`
  ).run(m, now, now, cleanGoal);
  const sessionId = Number(info.lastInsertRowid);
  const restMin = Number.isFinite(Number(restMinutes)) ? Math.min(Math.max(Number(restMinutes), 1), 30) : REST_DEFAULT_MINUTES;
  session = { phase: "focusing", sessionId, mode: m, goal: cleanGoal, startedAt: now, endAt, distracts: 0, restMinutes: restMin, restEndAt: null };
  lastStop = null;
  return { ok: true, sessionId, mode: m, goal: cleanGoal, endAt, phase: "focusing", restMinutes: restMin };
}

/** 手动结束：专注中 → 结束会话；休息中 → 结束休息 */
export function stopFocus(completed = true) {
  sweepExpired();
  if (!session) return { ok: false, error: "无进行中的专注或休息" };
  const now = Date.now();
  if (session.phase === "resting") {
    lastStop = { ...(lastStop || {}), completed: true, phase: "resting", restDone: true };
    session = null;
    return { ok: true, phase: "resting", restDone: true, durationMinutes: 0 };
  }
  const durationMinutes = Math.max(0, Math.round((now - session.startedAt) / 60000));
  const done = completed ? 1 : 0;
  db.prepare(
    "UPDATE focus_sessions SET ended_at = ?, completed = ?, distracts = ? WHERE id = ?"
  ).run(now, done, session.distracts, session.sessionId);
  lastStop = { completed: !!completed, durationMinutes, phase: "focusing", goal: session.goal || null };
  session = null;
  return { ok: true, durationMinutes, completed: !!completed, goal: lastStop.goal };
}

export function recordDistract() {
  sweepExpired();
  if (!session || session.phase !== "focusing") return { ok: false, error: "无进行中的专注" };
  session.distracts++;
  try {
    db.prepare("UPDATE focus_sessions SET distracts = ? WHERE id = ?").run(session.distracts, session.sessionId);
  } catch { /* 实时更新失败不影响内存计数（stopFocus 会再落库） */ }
  return { ok: true, distracts: session.distracts };
}

// ---------- 统计 ----------
// 今日：minutes=已完成会话时长（+进行中已流逝），count=已完成次数，distracts=分心次数
// 周：近 7 天每日完成分钟数；streak=连续完成天数（今天有算今天起，否则从昨天起）
export function getFocusStats(now = Date.now()) {
  sweepExpired(now);
  const start = startOfToday(now);
  const rows = db.prepare(
    "SELECT started_at, ended_at, completed, distracts FROM focus_sessions WHERE started_at >= ?"
  ).all(start);
  let minutes = 0, count = 0, distracts = 0;
  for (const r of rows) {
    const started = Number(r.started_at);
    const ended = Number(r.ended_at);
    const completed = Number(r.completed);
    const dcount = Number(r.distracts || 0);
    if (completed && ended) {
      count++;
      minutes += Math.max(0, Math.round((ended - started) / 60000));
      distracts += dcount;
    }
  }
  if (session && session.phase === "focusing") {
    minutes += Math.max(0, Math.round((now - session.startedAt) / 60000));
    distracts += session.distracts || 0;
  }
  // 近 7 天每日完成分钟 + 连续天数
  const week = [];
  let streak = 0;
  const dayMs = 24 * 3600 * 1000;
  for (let i = 6; i >= 0; i--) {
    const dayStart = startOfToday(now) - i * dayMs;
    const dayEnd = dayStart + dayMs;
    const dayRows = db.prepare(
      "SELECT started_at, ended_at, completed FROM focus_sessions WHERE started_at >= ? AND started_at < ?"
    ).all(dayStart, dayEnd);
    let dayMinutes = 0;
    for (const r of dayRows) {
      if (Number(r.completed) && r.ended_at) {
        dayMinutes += Math.max(0, Math.round((Number(r.ended_at) - Number(r.started_at)) / 60000));
      }
    }
    const d = new Date(dayStart);
    // 本地日期 ISO（面板按 "YYYY-MM-DD" 比对今日高亮；曾用 "M/D" → 星期标签退化/今日高亮永不命中）
    const pad = (n) => String(n).padStart(2, "0");
    week.push({ date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, minutes: dayMinutes });
  }
  // streak：今天有完成 → 从今天起；否则从昨天起
  for (let i = 0; i < 7; i++) {
    const dayStart = startOfToday(now) - i * dayMs;
    const dayEnd = dayStart + dayMs;
    const n = db.prepare("SELECT COUNT(*) n FROM focus_sessions WHERE started_at >= ? AND started_at < ? AND completed = 1").get(dayStart, dayEnd);
    if (Number(n?.n || 0) > 0) streak++;
    else if (i > 0) break; // 今天未完成不打断（从昨天开始算），更早中断则停
  }
  return { minutes, count, distracts, week, streak };
}

export function getFocusStatus(now = Date.now()) {
  const evt = sweepExpired(now);
  const stats = getFocusStats(now);
  const base = {
    active: false,
    phase: "idle",
    mode: null,
    sessionId: null,
    goal: null,
    remainingSeconds: 0,
    endAt: null,
    restEndAt: null,
    distracts: 0,
    lastCompleted: lastStop?.completed ?? false,
    restDone: lastStop?.restDone ?? false,
    lastGoal: lastStop?.goal || null,
    event: evt,
    todayMinutes: stats.minutes,
    todayCount: stats.count,
    todayDistracts: stats.distracts,
    week: stats.week,
    streak: stats.streak,
  };
  if (!session) {
    return { ...base, phase: "idle", active: false };
  }
  if (session.phase === "resting") {
    return {
      ...base,
      active: true,
      phase: "resting",
      goal: session.goal,
      restEndAt: session.restEndAt,
      remainingSeconds: Math.max(0, Math.ceil((session.restEndAt - now) / 1000)),
      distracts: 0,
    };
  }
  return {
    ...base,
    active: true,
    phase: "focusing",
    mode: session.mode,
    sessionId: session.sessionId,
    goal: session.goal,
    remainingSeconds: Math.max(0, Math.ceil((session.endAt - now) / 1000)),
    endAt: session.endAt,
    distracts: session.distracts,
  };
}

// 最近完成会话（带 goal，面板展示"本次专注了什么"）
export function getRecentSessions(limit = 5) {
  try {
    return db.prepare(
      "SELECT id, mode, started_at, ended_at, completed, distracts, goal FROM focus_sessions ORDER BY id DESC LIMIT ?"
    ).all(limit).map((r) => ({
      id: Number(r.id),
      mode: String(r.mode),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at ? Number(r.ended_at) : null,
      completed: !!r.completed,
      distracts: Number(r.distracts || 0),
      goal: r.goal ? String(r.goal) : null,
    }));
  } catch { return []; }
}

// 测试隔离：重置模块级会话状态（配合 clearAllTables 清 DB）
export function resetForTest() {
  session = null;
  lastStop = null;
}
