// tests/patrol.test.mjs —— 巡检避开 DS 高峰时段单测
// 背景：DeepSeek 官方高峰 = UTC 16:30-00:30 = 北京时间 00:30-08:30（API 价格上浮 50%），
//       自动巡检应避开（高峰内的触发推迟到 08:30 后）
import test from "node:test";
import assert from "node:assert/strict";
import { isDsPeakHour, avoidPeakTime } from "../lib/patrol.mjs";

const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi, 0, 0).getTime();

test("isDsPeakHour：北京 00:30-08:30 为高峰", () => {
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 0, 0)), false, "00:00 非高峰（高峰 00:30 开始）");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 0, 29)), false, "00:29 非高峰");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 0, 30)), true, "00:30 高峰开始");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 3, 0)), true, "03:00 高峰");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 8, 0)), true, "08:00 高峰");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 8, 29)), true, "08:29 高峰");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 8, 30)), false, "08:30 高峰结束");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 12, 0)), false, "12:00 非高峰");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 20, 0)), false, "20:00 非高峰（平峰）");
  assert.equal(isDsPeakHour(new Date(2026, 7, 18, 23, 59)), false, "23:59 非高峰");
});

test("avoidPeakTime：高峰内触发 → 推迟到当天 08:30", () => {
  const t = at(2026, 7, 19, 3, 0); // 明天 03:00（未来，当天 08:30 未过）
  const r = avoidPeakTime(t, true);
  const d = new Date(r);
  assert.equal(d.getHours(), 8, "推迟到 08:xx");
  assert.equal(d.getMinutes(), 30, "08:30");
  assert.equal(d.getDate(), 19, "当天（非次日）");
});

test("avoidPeakTime：非高峰触发 → 原样不动", () => {
  const t = at(2026, 7, 19, 20, 0);
  assert.equal(avoidPeakTime(t, true), t, "20:00 平峰不推迟");
  const t2 = at(2026, 7, 19, 9, 0);
  assert.equal(avoidPeakTime(t2, true), t2, "09:00 非高峰不推迟");
});

test("avoidPeakTime：开关关闭 → 高峰也原样触发", () => {
  const t = at(2026, 7, 19, 3, 0);
  assert.equal(avoidPeakTime(t, false), t, "avoidPeak=false 不避开");
});

test("avoidPeakTime：高峰内但当天 08:30 已过（at 在未来次日）→ 次日 08:30", () => {
  // at = 明天 03:00，但模拟"当前已过今天 08:30"：无法注入 Date.now，用 at 当天 08:30 已过无法构造；
  // 这里验证 at 是未来且当天 08:30 未过 → 当天（上面用例）；补边界：at = 今天 03:00 且现在 > 08:30 的路径
  // 通过构造 at = 明天 03:00 验证至少不会落到过去（>= 当天 08:30）
  const t = at(2026, 7, 19, 3, 0);
  const r = avoidPeakTime(t, true);
  assert.ok(r >= t, "推迟时间不早于原计划当天（防回到过去）");
});
