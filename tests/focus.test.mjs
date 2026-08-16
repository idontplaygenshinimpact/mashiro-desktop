// focus.mjs 测试：分心标题匹配 / 专注状态机 / 今日统计 / 黑名单（临时 DB 隔离）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb, clearAllTables } from "./helpers.mjs";

const dbDir = setupTempDb("focus");
const focus = await import("../lib/focus.mjs");
const { db } = await import("../lib/db.mjs");

beforeEach(async () => {
  await clearAllTables();
  db.exec("DELETE FROM focus_sessions;");
  focus.resetForTest();
});
after(() => { cleanupTempDb(dbDir); });

// ---------- 纯函数：标题命中分心黑名单 ----------
test("isDistractingTitle：命中黑名单关键词（大小写不敏感，包含即命中）", () => {
  const bl = ["哔哩哔哩", "bilibili", "Steam", "抖音"];
  assert.equal(focus.isDistractingTitle("bilibili - 哔哩哔哩", bl), true);
  assert.equal(focus.isDistractingTitle("STEAM Library", bl), true);
  assert.equal(focus.isDistractingTitle(" 哔哩哔哩 (3) 未读消息 ", bl), true);
  assert.equal(focus.isDistractingTitle("抖音短视频直播", bl), true);
  assert.equal(focus.isDistractingTitle("Visual Studio Code - coding", bl), false);
  assert.equal(focus.isDistractingTitle("", bl), false);
  assert.equal(focus.isDistractingTitle(null, bl), false);
});

test("isDistractingTitle：空关键词被过滤，不会误判所有标题", () => {
  assert.equal(focus.isDistractingTitle("任意标题", []), false);
  assert.equal(focus.isDistractingTitle("任意标题", ["", "  "]), false);
});

// ---------- 状态机 ----------
test("startFocus：校验 mode，非法值拒绝", () => {
  assert.equal(focus.startFocus("99").ok, false);
  assert.equal(focus.startFocus("").ok, false);
  assert.equal(focus.startFocus(null).ok, false);
});

test("startFocus/stopFocus/recordDistract/getFocusStatus 状态机", () => {
  const r = focus.startFocus("25");
  assert.equal(r.ok, true);
  assert.ok(r.sessionId > 0);
  assert.equal(r.mode, "25");
  assert.ok(Math.abs(r.endAt - (Date.now() + 25 * 60 * 1000)) < 5000);

  // 进行中拒绝二次开始
  assert.equal(focus.startFocus("45").ok, false);

  let s = focus.getFocusStatus();
  assert.equal(s.active, true);
  assert.equal(s.sessionId, r.sessionId);
  assert.ok(s.remainingSeconds > 0 && s.remainingSeconds <= 25 * 60);
  assert.equal(s.lastCompleted, false);

  // 分心记录（内存 + 落库）
  assert.equal(focus.recordDistract().distracts, 1);
  assert.equal(focus.recordDistract().distracts, 2);
  s = focus.getFocusStatus();
  assert.equal(s.distracts, 2);

  // 结束（完成）
  const stop = focus.stopFocus(true);
  assert.equal(stop.ok, true);
  assert.equal(stop.completed, true);
  assert.equal(stop.durationMinutes, 0); // 未满 1 分钟，四舍五入为 0

  s = focus.getFocusStatus();
  assert.equal(s.active, false);
  assert.equal(s.lastCompleted, true);
  assert.equal(s.todayCount, 1);

  // 落库校验：completed=1、distracts=2
  const row = db.prepare("SELECT completed, distracts, ended_at FROM focus_sessions WHERE id = ?").get(r.sessionId);
  assert.equal(row.completed, 1);
  assert.equal(row.distracts, 2);
  assert.ok(row.ended_at != null);

  // 无进行中时二次 stop/record 拒绝
  assert.equal(focus.stopFocus(true).ok, false);
  assert.equal(focus.recordDistract().ok, false);
});

test("stopFocus(false)：中断不计入完成次数", () => {
  focus.startFocus("45");
  const stop = focus.stopFocus(false);
  assert.equal(stop.completed, false);
  assert.equal(focus.getFocusStats().count, 0);
  assert.equal(focus.getFocusStatus().lastCompleted, false);
});

// ---------- 今日统计 ----------
test("getFocusStats：汇总今日已完成会话时长/次数/分心，昨日不计入", () => {
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  const todayStart = t0.getTime();
  const s1 = todayStart + 10 * 60 * 1000; // 今天 00:10
  db.prepare("INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at) VALUES (?,?,?,?,?,?)")
    .run("25", s1, s1 + 25 * 60 * 1000, 1, 2, s1);
  db.prepare("INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at) VALUES (?,?,?,?,?,?)")
    .run("45", s1 + 40 * 60 * 1000, s1 + 85 * 60 * 1000, 1, 0, s1);
  // 昨日会话（不计入今日）
  const yesterday = todayStart - 60 * 60 * 1000;
  db.prepare("INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at) VALUES (?,?,?,?,?,?)")
    .run("25", yesterday, yesterday + 25 * 60 * 1000, 1, 5, yesterday);
  // 今日但未完成的会话（不计入 count/minutes）
  db.prepare("INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at) VALUES (?,?,?,?,?,?)")
    .run("25", s1 + 120 * 60 * 1000, null, 0, 3, s1);

  // 用今天中午作为统计时点，避免午夜边界
  const stats = focus.getFocusStats(todayStart + 12 * 3600 * 1000);
  assert.equal(stats.count, 2);
  assert.equal(stats.minutes, 70);
  assert.equal(stats.distracts, 2);
});

test("getFocusStatus：进行中会话的已流逝分钟/剩余秒数", () => {
  const r = focus.startFocus("25");
  const startedAt = db.prepare("SELECT started_at FROM focus_sessions WHERE id = ?").get(r.sessionId).started_at;
  // 模拟专注已进行 10 分钟
  const s = focus.getFocusStatus(startedAt + 10 * 60 * 1000);
  assert.equal(s.active, true);
  assert.equal(s.remainingSeconds, 15 * 60);
  assert.equal(s.todayMinutes, 10); // 进行中已流逝计入今日
  assert.equal(s.todayCount, 0);    // 进行中不计入完成次数
});

// ---------- 黑名单 ----------
test("getBlacklist/setBlacklist 往返 + 去重 + 默认值", () => {
  // 未设置 → 默认
  assert.deepEqual(focus.getBlacklist(), focus.DEFAULT_BLACKLIST);
  // 设置（去重 + 去空白 + 过滤非字符串）
  const r = focus.setBlacklist([" B站 ", "B站", "", "Steam", 123, "抖音"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.blacklist, ["B站", "Steam", "抖音"]);
  assert.deepEqual(focus.getBlacklist(), ["B站", "Steam", "抖音"]);
  // 非数组拒绝
  assert.equal(focus.setBlacklist("not-array").ok, false);
  // 设置后 isDistractingTitle 用新黑名单
  assert.equal(focus.isDistractingTitle("B站直播", focus.getBlacklist()), true);
  assert.equal(focus.isDistractingTitle("哔哩哔哩", focus.getBlacklist()), false);
});

// ================= 增强：进程名/正则规则 + 白名单 =================
test("isDistracting：进程名规则 + 正则规则 + 关键词规则", () => {
  const bl = ["bilibili", "进程名:WeChat.exe", "/抖音|快手/"];
  // 关键词（标题）
  assert.equal(focus.isDistracting({ title: "bilibili 直播" }, bl, []).distracting, true);
  // 进程名
  assert.equal(focus.isDistracting({ title: "聊天窗口", processName: "WeChat.exe" }, bl, []).distracting, true);
  assert.equal(focus.isDistracting({ title: "聊天窗口", processName: "WeChatAppEx.exe" }, bl, []).distracting, false, "进程名包含匹配（WeChatAppEx 不含 WeChat.exe）");
  // 正则
  assert.equal(focus.isDistracting({ title: "抖音极速版" }, bl, []).distracting, true);
  assert.equal(focus.isDistracting({ title: "抖音极速版" }, bl, []).rule, "/抖音|快手/", "返回命中规则");
  // 未命中
  assert.equal(focus.isDistracting({ title: "VS Code", processName: "Code.exe" }, bl, []).distracting, false);
});

test("isDistracting：白名单优先（命中白名单 → 不报分心）", () => {
  const bl = ["bilibili", "进程名:chrome.exe"];
  const wl = ["进程名:Code.exe", "/哔哩哔哩/"];
  // 黑名单命中但白名单进程命中 → 不报
  assert.equal(focus.isDistracting({ title: "哔哩哔哩 - 学习视频", processName: "Code.exe" }, bl, wl).distracting, false);
  // 黑名单标题命中 + 白名单正则命中 → 不报
  assert.equal(focus.isDistracting({ title: "哔哩哔哩 - 面经视频", processName: "chrome.exe" }, bl, wl).distracting, false);
  // 无白名单命中 → 报
  assert.equal(focus.isDistracting({ title: "哔哩哔哩 - 番剧", processName: "chrome.exe" }, bl, []).distracting, true);
  // 返回原因
  const r = focus.isDistracting({ title: "x", processName: "Code.exe" }, bl, wl);
  assert.ok(r.reason.includes("白名单"), "白名单命中带原因");
});

test("setWhitelist/getWhitelist 往返", () => {
  const r = focus.setWhitelist(["进程名:Code.exe", "进程名:Code.exe", ""]);
  assert.equal(r.ok, true);
  assert.deepEqual(focus.getWhitelist(), ["进程名:Code.exe"]);
});

// ================= 番茄循环：到期自动完成 → 休息 → 自动结束 =================
test("sweepExpired：专注到点自动完成并进入休息（phase=resting）", () => {
  const r = focus.startFocus("25", { goal: "学事件循环" });
  assert.equal(r.ok, true);
  // 模拟到点（startedAt + 25min + 1s）
  const startedAt = db.prepare("SELECT started_at FROM focus_sessions WHERE id = ?").get(r.sessionId).started_at;
  const s = focus.getFocusStatus(startedAt + 25 * 60 * 1000 + 1000);
  assert.equal(s.phase, "resting", "自动进入休息");
  assert.equal(s.active, true);
  assert.ok(s.restEndAt > 0);
  assert.equal(s.goal, "学事件循环", "目标延续到休息阶段");
  // DB 落库：completed=1
  const row = db.prepare("SELECT completed, ended_at FROM focus_sessions WHERE id = ?").get(r.sessionId);
  assert.equal(row.completed, 1, "到期自动标记完成");
  assert.ok(row.ended_at != null);
  // 今日完成次数 +1
  assert.equal(focus.getFocusStatus().todayCount, 1);
});

test("sweepExpired：休息到点自动结束（restDone=true，phase=idle）", () => {
  focus.startFocus("25", { goal: "刷真题" });
  const startedAt = db.prepare("SELECT started_at FROM focus_sessions ORDER BY id DESC LIMIT 1").get().started_at;
  // 专注到点 → 休息中
  let s = focus.getFocusStatus(startedAt + 25 * 60 * 1000 + 1000);
  assert.equal(s.phase, "resting");
  // 休息 5 分钟到点 → 自动结束
  s = focus.getFocusStatus(s.restEndAt + 1000);
  assert.equal(s.phase, "idle");
  assert.equal(s.active, false);
  assert.equal(s.restDone, true, "休息完成标记");
});

test("stopFocus：休息中手动结束休息；休息中可再 startFocus 开下一轮", () => {
  focus.startFocus("25");
  const startedAt = db.prepare("SELECT started_at FROM focus_sessions ORDER BY id DESC LIMIT 1").get().started_at;
  const s = focus.getFocusStatus(startedAt + 25 * 60 * 1000 + 1000); // 进入休息
  assert.equal(s.phase, "resting");
  // 休息中 stop → 结束休息
  const stop = focus.stopFocus(true);
  assert.equal(stop.ok, true);
  assert.equal(stop.phase, "resting");
  assert.equal(focus.getFocusStatus().phase, "idle");
  // 休息中直接开始下一轮（startFocus 自动结束休息）
  focus.startFocus("25");
  const s2 = focus.getFocusStatus(); // 用真实当前时间查询（避免过去时间点触发 sweep）
  assert.equal(s2.phase, "focusing", "休息中可直接开始新一轮");
  assert.equal(focus.getFocusStatus().todayCount, 1, "上一轮已计入完成");
});

// ================= goal 记录 =================
test("startFocus 带 goal：落库 + 状态透出", () => {
  const r = focus.startFocus("45", { goal: " 学习 React Hooks " });
  assert.equal(r.ok, true);
  assert.equal(r.goal, "学习 React Hooks", "goal 去空白");
  const row = db.prepare("SELECT goal FROM focus_sessions WHERE id = ?").get(r.sessionId);
  assert.equal(row.goal, "学习 React Hooks", "goal 落库");
  assert.equal(focus.getFocusStatus().goal, "学习 React Hooks");
  // 无 goal（先结束当前会话再开新的）
  focus.stopFocus(true);
  const r2 = focus.startFocus("25");
  assert.equal(r2.goal, null);
});

// ================= 周统计 + streak =================
test("getFocusStats：week 近 7 天 + streak 连续天数", () => {
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  const todayStart = t0.getTime();
  const dayMs = 24 * 3600 * 1000;
  // 今天 1 次、昨天 1 次、前天 0 次 → streak=2
  db.prepare("INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at) VALUES (?,?,?,?,?,?)")
    .run("25", todayStart + 10 * 60 * 1000, todayStart + 35 * 60 * 1000, 1, 0, todayStart);
  db.prepare("INSERT INTO focus_sessions (mode, started_at, ended_at, completed, distracts, created_at) VALUES (?,?,?,?,?,?)")
    .run("25", todayStart - dayMs + 10 * 60 * 1000, todayStart - dayMs + 35 * 60 * 1000, 1, 0, todayStart - dayMs);
  const stats = focus.getFocusStats(todayStart + 12 * 3600 * 1000);
  assert.equal(stats.streak, 2, "今天+昨天连续完成 → streak=2");
  assert.equal(stats.week.length, 7);
  assert.equal(stats.week[6].minutes, 25, "今天 25 分钟");
  assert.equal(stats.week[5].minutes, 25, "昨天 25 分钟");
  assert.equal(stats.week[4].minutes, 0, "前天 0");
});
