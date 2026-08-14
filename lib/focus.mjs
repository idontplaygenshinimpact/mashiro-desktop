// 专注监督（番茄钟）：开始专注 → 桌宠陪伴 → 分心应用检测提醒 → 结束统计
// 数据：focus_sessions 表（db.mjs schema）+ settings 表 focus_blacklist
// 设计：本模块不依赖 widget/electron，纯 node:sqlite + 纯函数，可独立单元测试
import { db } from "./db.mjs";

// 分心黑名单默认值（命中前台窗口标题即视为分心，大小写不敏感）
export const DEFAULT_BLACKLIST = [
  "哔哩哔哩", "bilibili", "Steam", "原神", "抖音", "YouTube",
  "Netflix", "爱奇艺", "腾讯视频", "斗鱼", "虎牙",
];

// ---------- 模块级活动状态（单进程内唯一进行中的专注） ----------
let active = null;     // { sessionId, mode, startedAt, endAt, distracts }
let lastStop = null;   // { completed, durationMinutes } 上次结束结果（供 getFocusStatus 告知完成态）

// 时长模式 → 分钟
const MODES = { "25": 25, "45": 45 };

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

// ---------- settings 读写（focus_blacklist） ----------
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

// ---------- 分心黑名单 ----------
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

export function setBlacklist(list) {
  if (!Array.isArray(list)) return { ok: false, error: "blacklist 必须是数组" };
  // 去重 + 去空白 + 过滤空项
  const clean = [...new Set(list.filter((s) => typeof s === "string" && s.trim()).map((s) => s.trim()))];
  try {
    writeSetting("focus_blacklist", JSON.stringify(clean));
    return { ok: true, blacklist: clean };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 纯函数：标题是否命中分心黑名单（大小写不敏感，包含即命中） ----------
export function isDistractingTitle(title, blacklist) {
  const t = String(title || "").toLowerCase().trim();
  if (!t) return false;
  const list = Array.isArray(blacklist) ? blacklist : [];
  for (const kw of list) {
    const k = String(kw || "").toLowerCase().trim();
    if (k && t.includes(k)) return true;
  }
  return false;
}

// ---------- 专注会话状态机 ----------
export function startFocus(mode) {
  const m = String(mode || "");
  if (!MODES[m]) return { ok: false, error: "mode 必须是 25 或 45" };
  if (active) return { ok: false, error: "已有进行中的专注，先结束再开始" };
  const now = Date.now();
  const endAt = now + MODES[m] * 60 * 1000;
  const info = db.prepare(
    `INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at)
     VALUES (?, ?, NULL, 0, 0, ?)`
  ).run(m, now, now);
  const sessionId = Number(info.lastInsertRowid);
  active = { sessionId, mode: m, startedAt: now, endAt, distracts: 0 };
  lastStop = null;
  return { ok: true, sessionId, mode: m, endAt };
}

export function stopFocus(completed) {
  if (!active) return { ok: false, error: "无进行中的专注" };
  const now = Date.now();
  const durationMinutes = Math.max(0, Math.round((now - active.startedAt) / 60000));
  const done = completed ? 1 : 0;
  db.prepare(
    "UPDATE focus_sessions SET ended_at = ?, completed = ?, distracts = ? WHERE id = ?"
  ).run(now, done, active.distracts, active.sessionId);
  lastStop = { completed: !!completed, durationMinutes };
  active = null;
  return { ok: true, durationMinutes, completed: !!completed };
}

export function recordDistract() {
  if (!active) return { ok: false, error: "无进行中的专注" };
  active.distracts++;
  try {
    db.prepare("UPDATE focus_sessions SET distracts = ? WHERE id = ?").run(active.distracts, active.sessionId);
  } catch { /* 实时更新失败不影响内存计数（stopFocus 会再落库） */ }
  return { ok: true, distracts: active.distracts };
}

// 今日统计：minutes=已完成会话时长（+进行中已流逝），count=已完成次数，distracts=分心次数
export function getFocusStats(now = Date.now()) {
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
  // 进行中会话的已流逝分钟/分心次数也计入今日（面板实时可见）
  if (active) {
    minutes += Math.max(0, Math.round((now - active.startedAt) / 60000));
    distracts += active.distracts || 0;
  }
  return { minutes, count, distracts };
}

export function getFocusStatus(now = Date.now()) {
  const stats = getFocusStats(now);
  if (!active) {
    return {
      active: false,
      mode: null,
      sessionId: null,
      remainingSeconds: 0,
      endAt: null,
      distracts: 0,
      lastCompleted: lastStop?.completed ?? false,
      todayMinutes: stats.minutes,
      todayCount: stats.count,
      todayDistracts: stats.distracts,
    };
  }
  return {
    active: true,
    mode: active.mode,
    sessionId: active.sessionId,
    remainingSeconds: Math.max(0, Math.ceil((active.endAt - now) / 1000)),
    endAt: active.endAt,
    distracts: active.distracts,
    lastCompleted: false,
    todayMinutes: stats.minutes,
    todayCount: stats.count,
    todayDistracts: stats.distracts,
  };
}

// 测试隔离：重置模块级活动状态（配合 clearAllTables 清 DB）
export function resetForTest() {
  active = null;
  lastStop = null;
}
