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
