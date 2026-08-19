// tests/patrol.test.mjs —— 巡检避开 DS 峰时段单测
// 背景：DeepSeek 2026-08-16 起峰谷计价（官方 + dsh-handbook 14-cost 实测）：
//       峰时（北京时间）= 09:00-12:00 + 14:00-18:00（价格 2 倍），其余谷时半价。
//       自动巡检应避开峰时（推到窗口结束或次日谷时）
import test from "node:test";
import assert from "node:assert/strict";
import { isDsPeakHour, avoidPeakTime } from "../lib/patrol.mjs";

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime();

test("isDsPeakHour：北京 09:00-12:00 + 14:00-18:00 为峰时", () => {
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 8, 59)), false, "08:59 谷时（早 9 点前便宜）");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 9, 0)), true, "09:00 峰时开始");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 11, 59)), true, "11:59 峰时");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 12, 0)), false, "12:00 午休谷时");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 13, 0)), false, "13:00 谷时");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 14, 0)), true, "14:00 峰时开始（下午段）");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 17, 59)), true, "17:59 峰时");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 18, 0)), false, "18:00 峰时结束（晚上谷时）");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 20, 0)), false, "20:00 谷时（最便宜时段）");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 0, 30)), false, "凌晨谷时");
});

test("avoidPeakTime：上午峰时触发 → 推迟到当天 12:00", () => {
  const t = at(2027, 7, 19, 10, 0); // 明天 10:00（未来）
  const r = avoidPeakTime(t, true);
  const d = new Date(r);
  assert.equal(d.getHours(), 12, "推迟到 12:00");
  assert.equal(d.getMinutes(), 0);
  assert.equal(d.getDate(), 19, "当天");
});

test("avoidPeakTime：下午峰时触发 → 推迟到当天 18:00", () => {
  const t = at(2027, 7, 19, 15, 30);
  const r = avoidPeakTime(t, true);
  const d = new Date(r);
  assert.equal(d.getHours(), 18, "推迟到 18:00");
  assert.equal(d.getDate(), 19, "当天");
});

test("avoidPeakTime：谷时触发 → 原样不动", () => {
  const t = at(2027, 7, 19, 20, 0);
  assert.equal(avoidPeakTime(t, true), t, "晚上谷时不推迟");
  const t2 = at(2027, 7, 19, 8, 0);
  assert.equal(avoidPeakTime(t2, true), t2, "早 8 点谷时不推迟");
  const t3 = at(2027, 7, 19, 13, 0);
  assert.equal(avoidPeakTime(t3, true), t3, "午休谷时不推迟");
});

test("avoidPeakTime：开关关闭 → 峰时也原样触发", () => {
  const t = at(2027, 7, 19, 10, 0);
  assert.equal(avoidPeakTime(t, false), t, "avoidPeak=false 不避开");
});

test("avoidPeakTime：推迟目标已过 → 次日 00:30 谷时（不撞次日峰时）", () => {
  // 构造 at = 今天 10:00（若现在已过 12:00 → 次日 00:30；未过 → 当天 12:00）
  const t = at(2027, 7, 19, 10, 0);
  const r = avoidPeakTime(t, true);
  const d = new Date(r);
  // 无论哪种分支，结果都必须是谷时（09:00 前或 12-14 或 18 点后）
  const h = d.getHours() + d.getMinutes() / 60;
  const isOffPeak = !((h >= 9 && h < 12) || (h >= 14 && h < 18));
  assert.ok(isOffPeak, `结果 ${d.toLocaleString("zh-CN")} 必须落在谷时`);
});

// 回归护栏：widget 曾因 createPatrol 内部同名 avoidPeakTime 无限递归 → 启动即崩 →
// ensure 每 30s 无限重拉（日志 20+ 次"已后台拉起"）。模块级单测测不到内部遮蔽，
// 必须走 createPatrol 真实路径。
test("createPatrol 集成：scheduleNext 排程不崩 + 排程时间避开峰时", async () => {
  const { setupTempDb, cleanupTempDb } = await import("./helpers.mjs");
  const dbDir = setupTempDb("patrol-integ");
  const { createPatrol } = await import("../lib/patrol.mjs");
  const patrol = createPatrol({
    disabled: false,
    sendNotification: async () => {},
    crawlMutex: { isRunning: () => false },
    runDiscoverHidden: async () => {},
  });
  try {
    assert.doesNotThrow(() => patrol.scheduleNext(), "排程不得抛错（曾递归栈溢出崩 widget）");
    const cfg = patrol.getConfig();
    assert.equal(cfg.ok, true);
    assert.ok(cfg.nextRun > 0, "已排程下次触发");
    const d = new Date(cfg.nextRun);
    const h = d.getHours() + d.getMinutes() / 60;
    const isOffPeak = !((h >= 9 && h < 12) || (h >= 14 && h < 18));
    assert.ok(isOffPeak, `排程时间 ${d.toLocaleString("zh-CN")} 应避开峰时（谷时半价）`);
  } finally {
    patrol.stop(); // 清 timer（防挂住测试进程）
    cleanupTempDb(dbDir);
  }
});
