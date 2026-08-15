// scheduler.mjs 单测：持久化定时任务（临时 DB + 注入时钟 + 注入 executes，全离线，无真实定时器）
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { setupTempDb, cleanupTempDb } from "./helpers.mjs";

const dbDir = setupTempDb("scheduler");
const { db } = await import("../lib/db.mjs");
const { createScheduler, parseSpec, computeNextRun, HEARTBEAT_OK } = await import("../lib/scheduler.mjs");

const T0 = new Date(2026, 7, 15, 8, 0, 0, 0).getTime(); // 2026-08-15 08:00:00 本地
let clock = T0;

function makeScheduler(executes = {}) {
  return createScheduler({
    db,
    now: () => clock,
    executes,
  });
}

beforeEach(() => {
  clock = T0;
  db.exec("DELETE FROM scheduled_jobs");
});
after(() => { cleanupTempDb(dbDir); });

// ---------- parseSpec ----------
test("parseSpec interval:N 每 N 分钟", () => {
  assert.equal(parseSpec("interval:30", 0), 30 * 60 * 1000);
  assert.equal(parseSpec("interval:1", 5000), 5000 + 60 * 1000);
  assert.equal(parseSpec(" interval:5 ", 0), 5 * 60 * 1000);
  assert.equal(parseSpec("interval:0", 0), null);
  assert.equal(parseSpec("interval:abc", 0), null);
  assert.equal(parseSpec("", 0), null);
  assert.equal(parseSpec(null, 0), null);
});

test("parseSpec daily:HHmm 每天 HH:mm（严格未来）", () => {
  const now = new Date(2026, 7, 15, 8, 30, 0, 0).getTime(); // 08:30
  const next = new Date(parseSpec("daily:0900", now));
  assert.equal(next.getDate(), 15); // 今天 9 点还没过
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 0);
  // 已过 9 点 → 明天 9 点
  const now2 = new Date(2026, 7, 15, 10, 0, 0, 0).getTime();
  const next2 = new Date(parseSpec("daily:0900", now2));
  assert.equal(next2.getDate(), 16);
  assert.equal(next2.getHours(), 9);
  // 非法
  assert.equal(parseSpec("daily:2500", now), null);
  assert.equal(parseSpec("daily:0961", now), null);
  assert.equal(parseSpec("daily:9", now), null);
});

test("parseSpec cron-lite 5 段（仅 * 与数字）", () => {
  const now = new Date(2026, 7, 15, 8, 0, 0, 0).getTime();
  // 每天 08:30
  const next = new Date(parseSpec("30 8 * * *", now));
  assert.equal(next.getDate(), 15);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 30);
  // 已过 08:30 → 明天
  const now2 = new Date(2026, 7, 15, 9, 0, 0, 0).getTime();
  const next2 = new Date(parseSpec("30 8 * * *", now2));
  assert.equal(next2.getDate(), 16);
  assert.equal(next2.getHours(), 8);
  assert.equal(next2.getMinutes(), 30);
  // 每小时整点（分=0 时=*）
  const now3 = new Date(2026, 7, 15, 8, 15, 0, 0).getTime();
  const next3 = new Date(parseSpec("0 * * * *", now3));
  assert.equal(next3.getHours(), 9);
  assert.equal(next3.getMinutes(), 0);
  // 非法：越界 / 不支持 / 段数不对 / 非法字符
  assert.equal(parseSpec("61 * * * *", now), null);
  assert.equal(parseSpec("0 25 * * *", now), null);
  assert.equal(parseSpec("0 0 32 * *", now), null);
  assert.equal(parseSpec("0 0 * 13 *", now), null);
  assert.equal(parseSpec("0 0 * * 7", now), null);
  assert.equal(parseSpec("*/5 * * * *", now), null);
  assert.equal(parseSpec("0 0 * *", now), null);
  assert.equal(parseSpec("a b c d e", now), null);
});

test("parseSpec 严格未来：刚好在整分钟上不返回当下", () => {
  // 08:15:00 精确落在 cron 命中时刻 → 应返回明天，而非当下（防死循环）
  const now = new Date(2026, 7, 15, 8, 15, 0, 0).getTime();
  const next = new Date(parseSpec("15 8 * * *", now));
  assert.equal(next.getDate(), 16);
  assert.equal(next.getHours(), 8);
  assert.equal(next.getMinutes(), 15);
});

// ---------- computeNextRun ----------
test("computeNextRun 用 job.schedule_spec 算下一次", () => {
  assert.equal(computeNextRun({ schedule_spec: "interval:10" }, 0), 10 * 60 * 1000);
  assert.equal(computeNextRun({ schedule_spec: "bad" }, 0), null);
  assert.equal(computeNextRun(null, 0), null);
});

// ---------- registerJob / listJobs / getJob ----------
test("registerJob 落库 + list/get 读取", () => {
  const s = makeScheduler();
  const job = s.registerJob({ name: "测试", job_type: "patrol", schedule_spec: "interval:30", config: { a: 1 } });
  assert.ok(job.id);
  assert.equal(job.name, "测试");
  assert.equal(job.job_type, "patrol");
  assert.equal(job.enabled, true);
  assert.equal(job.consecutive_failures, 0);
  assert.equal(job.last_run_at, null);
  assert.equal(job.next_run_at, clock + 30 * 60 * 1000);
  assert.deepEqual(job.config, { a: 1 });

  const all = s.listJobs();
  assert.equal(all.length, 1);
  assert.deepEqual(s.getJob(job.id), all[0]);
  assert.equal(s.getJob("nope"), null);
});

test("registerJob 缺 name 回退 job_type，缺 config 回退 {}", () => {
  const s = makeScheduler();
  const job = s.registerJob({ job_type: "rss_digest", schedule_spec: "daily:0900" });
  assert.equal(job.name, "rss_digest");
  assert.deepEqual(job.config, {});
});

// ---------- enableJob / disableJob ----------
test("enableJob 禁用 → enabled=false 且 next_run_at=null；重新启用 → 重算并清零失败", () => {
  const s = makeScheduler();
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:30" });

  const off = s.enableJob(job.id, false);
  assert.equal(off.enabled, false);
  assert.equal(off.next_run_at, null);

  // 重新启用：next_run_at 重算（clock 推进到 10 分钟后）
  clock = T0 + 10 * 60 * 1000;
  const on = s.enableJob(job.id, true);
  assert.equal(on.enabled, true);
  assert.equal(on.next_run_at, clock + 30 * 60 * 1000);
  assert.equal(on.consecutive_failures, 0);

  assert.equal(s.enableJob("nope", true), null);
});

// ---------- deleteJob ----------
test("deleteJob 删除并返回是否删除", () => {
  const s = makeScheduler();
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:30" });
  assert.equal(s.deleteJob(job.id), true);
  assert.equal(s.getJob(job.id), null);
  assert.equal(s.deleteJob(job.id), false);
});

// ---------- updateJob ----------
test("updateJob 改 name/config/schedule_spec（改排程重算 next_run_at）", () => {
  const s = makeScheduler();
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:30" });

  const upd = s.updateJob(job.id, { name: "新名字", schedule_spec: "interval:60" });
  assert.equal(upd.name, "新名字");
  assert.equal(upd.schedule_spec, "interval:60");
  assert.equal(upd.next_run_at, clock + 60 * 60 * 1000);

  const upd2 = s.updateJob(job.id, { config: { k: "v" } });
  assert.deepEqual(upd2.config, { k: "v" });
  assert.equal(upd2.next_run_at, clock + 60 * 60 * 1000); // 只改 config 不重算排程

  assert.equal(s.updateJob("nope", { name: "x" }), null);
});

test("updateJob 禁用/启用", () => {
  const s = makeScheduler();
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:30" });
  const off = s.updateJob(job.id, { enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.next_run_at, null);
  const on = s.updateJob(job.id, { enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.next_run_at, clock + 30 * 60 * 1000);
});

// ---------- checkDue ----------
test("checkDue 只跑到期任务，成功后更新 last_run_at/next_run_at/清零失败", async () => {
  const order = [];
  const s = makeScheduler({
    patrol: async (job) => { order.push(job.id); return { ok: true }; },
  });
  const a = s.registerJob({ job_type: "patrol", schedule_spec: "interval:30" }); // next = clock+30min
  const b = s.registerJob({ job_type: "patrol", schedule_spec: "interval:120" }); // next = clock+120min

  // 30 分钟后：只有 a 到期
  clock = T0 + 30 * 60 * 1000;
  const r1 = await s.checkDue(clock);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].ok, true);
  assert.deepEqual(order, [a.id]);

  const a1 = s.getJob(a.id);
  assert.equal(a1.last_run_at, clock);
  assert.equal(a1.next_run_at, clock + 30 * 60 * 1000);
  assert.equal(a1.consecutive_failures, 0);
  // b 未动
  const b1 = s.getJob(b.id);
  assert.equal(b1.last_run_at, null);
  assert.equal(b1.next_run_at, T0 + 120 * 60 * 1000);
});

test("checkDue 串行执行到期任务（顺序可断言）", async () => {
  const order = [];
  const s = makeScheduler({
    patrol: async (job) => {
      order.push(`start:${job.id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${job.id}`);
      return { ok: true };
    },
  });
  const a = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  const b = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  clock = T0 + 60 * 1000;
  await s.checkDue(clock);
  assert.deepEqual(order, [`start:${a.id}`, `end:${a.id}`, `start:${b.id}`, `end:${b.id}`]);
});

test("checkDue 失败计数累加，第 10 次自动禁用并记 reason", async () => {
  const s = makeScheduler({
    patrol: async () => { throw new Error("boom"); },
  });
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });

  for (let i = 1; i <= 9; i++) {
    clock = T0 + i * 60 * 1000;
    const r = await s.checkDue(clock);
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, false);
    const cur = s.getJob(job.id);
    assert.equal(cur.enabled, true, `第 ${i} 次失败仍启用`);
    assert.equal(cur.consecutive_failures, i);
  }
  // 第 10 次 → 自动禁用
  clock = T0 + 10 * 60 * 1000;
  const r = await s.checkDue(clock);
  assert.equal(r[0].disabled, true);
  const cur = s.getJob(job.id);
  assert.equal(cur.enabled, false);
  assert.equal(cur.consecutive_failures, 10);
  assert.equal(cur.next_run_at, null);
  assert.equal(cur.config.disabled_reason, "boom");
  assert.ok(cur.config.disabled_at);

  // 禁用后不再到期
  clock = T0 + 11 * 60 * 1000;
  assert.equal((await s.checkDue(clock)).length, 0);
});

test("checkDue 返回 {ok:false,error} 也算失败；成功清零失败计数", async () => {
  let fail = true;
  const s = makeScheduler({
    patrol: async () => (fail ? { ok: false, error: "网络错误" } : { ok: true }),
  });
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });

  clock = T0 + 60 * 1000;
  await s.checkDue(clock);
  assert.equal(s.getJob(job.id).consecutive_failures, 1);

  fail = false;
  clock = T0 + 2 * 60 * 1000;
  const r = await s.checkDue(clock);
  assert.equal(r[0].ok, true);
  const cur = s.getJob(job.id);
  assert.equal(cur.consecutive_failures, 0);
});

test("checkDue 跳过禁用任务", async () => {
  const order = [];
  const s = makeScheduler({
    patrol: async (job) => { order.push(job.id); return { ok: true }; },
  });
  const a = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  const b = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  s.enableJob(b.id, false);

  clock = T0 + 60 * 1000;
  const r = await s.checkDue(clock);
  assert.equal(r.length, 1);
  assert.deepEqual(order, [a.id]);
});

test("checkDue 无执行器的任务幂等跳过（不崩溃、不计失败）", async () => {
  const s = makeScheduler({}); // 无 patrol 执行器
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  clock = T0 + 60 * 1000;
  const r = await s.checkDue(clock);
  assert.equal(r.length, 1);
  assert.equal(r[0].skipped, "no-executor");
  assert.equal(s.getJob(job.id).consecutive_failures, 0);
});

test("checkDue 重入保护：并发调用只跑一轮", async () => {
  const order = [];
  const s = makeScheduler({
    patrol: async (job) => { order.push(job.id); await new Promise((r) => setTimeout(r, 20)); return { ok: true }; },
  });
  const a = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  clock = T0 + 60 * 1000;
  const [r1, r2] = await Promise.all([s.checkDue(clock), s.checkDue(clock)]);
  assert.equal(r1.length + r2.length, 1, "两路 checkDue 只跑出一轮");
  assert.deepEqual(order, [a.id]);
});

// ---------- HEARTBEAT_OK 契约 ----------
test("HEARTBEAT_OK：未完成不计失败、不重置、短时重试", async () => {
  const s = makeScheduler({
    patrol: async () => {
      return { ok: false, heartbeat: HEARTBEAT_OK }; // 等价 { heartbeat: true }
    },
  });
  const job = s.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  clock = T0 + 60 * 1000;
  const r = await s.checkDue(clock);
  assert.equal(r[0].heartbeat, true);
  const cur = s.getJob(job.id);
  assert.equal(cur.consecutive_failures, 0, "心跳不计失败");
  assert.equal(cur.last_run_at, null, "心跳不更新 last_run_at");
  assert.equal(cur.enabled, true);
  assert.equal(cur.next_run_at, clock + 5 * 60 * 1000, "心跳后 5 分钟重试");

  // 直接返回 HEARTBEAT_OK 字符串也算心跳
  clock = T0;
  const s2 = makeScheduler({ patrol: async () => HEARTBEAT_OK });
  const j2 = s2.registerJob({ job_type: "patrol", schedule_spec: "interval:1" });
  clock = T0 + 60 * 1000;
  const r2 = await s2.checkDue(clock);
  assert.equal(r2[0].heartbeat, true);
  assert.equal(s2.getJob(j2.id).consecutive_failures, 0);
});

// ---------- 持久化：跨 scheduler 实例仍读同一张表 ----------
test("job 持久化在 DB，跨实例可见", () => {
  const s1 = makeScheduler();
  const job = s1.registerJob({ job_type: "patrol", schedule_spec: "interval:30" });
  const s2 = makeScheduler();
  assert.equal(s2.getJob(job.id).schedule_spec, "interval:30");
  assert.equal(s2.listJobs().length, 1);
});
