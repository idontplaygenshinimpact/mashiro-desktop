// lib/scheduler.ts —— 持久化定时任务调度器（OpenClaw Automations 风格）
// 纯模块（无副作用）：不 import db、不起定时器，只导出 parseSpec / computeNextRun / createScheduler。
//
// schedule_spec 三种格式（parseSpec 解析为「下一次运行时间戳」，毫秒，无效返回 null）：
//   "interval:N"  每 N 分钟（N 为正整数）
//   "daily:HHmm"  每天 HH:mm（本地时区）
//   "* * * * *"   5 段 cron-lite（分 时 日 月 周；每段仅支持 `*` 或单个数字）
//
// 调度契约（checkDue）：
//   - 串行跑所有「enabled=1 且 next_run_at <= now」的任务
//   - executor 返回 { ok: true } → 成功（重置失败计数，last_run_at=now，排下一次）
//   - executor 抛错或返回 { ok: false, error } → 失败（计数+1；连续 ≥10 自动禁用并在 config 记 reason）
//   - executor 返回 { ok: false, heartbeat: true }（或直接返回 HEARTBEAT_OK）→ HEARTBEAT_OK 契约：
//     「仍存活但未完成」——不计失败、不重置计数、last_run_at 不动，短时间后重试（unattended 长期任务）
// 全量 TS 升级工单阶段 3：lib/scheduler.mjs → .ts（调用方 widget.mjs 静态 import 与 tests 按 .mjs 路径加载 → 保留同名一行桶）
import { randomUUID } from "node:crypto";

export const HEARTBEAT_OK = "HEARTBEAT_OK";
const AUTO_DISABLE_AFTER = 10;            // 连续失败 N 次自动禁用
const HEARTBEAT_RETRY_MS = 5 * 60 * 1000; // heartbeat 后重试间隔（5 分钟）

/** 持久化任务（DB 行 ↔ JS 对象的统一形状：enabled→bool、config→对象、时间戳→number|null） */
export interface ScheduledJob {
  id: string;
  name: string;
  job_type: string;
  schedule_spec: string;
  enabled: boolean;
  config: Record<string, unknown>;
  last_run_at: number | null;
  next_run_at: number | null;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
}

/** 新建任务入参（id/时间戳/next_run_at 由调度器补） */
export interface JobInput {
  id?: string;
  name?: string;
  job_type: string;
  schedule_spec: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** 局部更新（未提供的字段保持原值） */
export interface JobPatch {
  name?: string;
  job_type?: string;
  schedule_spec?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
}

/** executor 返回值：{ok:false,error} 失败；HEARTBEAT_OK / {heartbeat:true} 为「存活但未完成」 */
export type JobResult = { ok?: boolean; error?: string; heartbeat?: unknown } | string | null | undefined;

/** 单次执行结局（checkDue 返回数组的元素） */
export interface RunOutcome {
  id: string;
  ok: boolean;
  error?: string | null;
  failures?: number;
  disabled?: boolean;
  heartbeat?: boolean;
  skipped?: string;
}

/** node:sqlite DatabaseSync 的最小面（只用到 prepare；语句对象按用到的三个方法收口）
 * changes 按 @types/node 的 StatementSync 声明为 number|bigint（调用处 Number() 归一） */
interface SchedulerStmt {
  run: (...args: unknown[]) => { changes?: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}
export interface SchedulerDb { prepare: (sql: string) => SchedulerStmt }

export interface SchedulerOptions {
  db: SchedulerDb;
  /** 当前时间函数（默认 Date.now），测试可注入固定时钟；也接受固定数字 */
  now?: (() => number) | number;
  executes?: Record<string, (job: ScheduledJob) => Promise<JobResult> | JobResult>;
}

export interface Scheduler {
  registerJob(job: JobInput): ScheduledJob | null;
  listJobs(): ScheduledJob[];
  getJob(id: string): ScheduledJob | null;
  enableJob(id: string, bool: unknown): ScheduledJob | null;
  deleteJob(id: string): boolean;
  updateJob(id: string, patch?: JobPatch): ScheduledJob | null;
  checkDue(now?: number): Promise<RunOutcome[]>;
}

// ---------- schedule_spec → 下一次运行时间戳（毫秒）；无效 spec 返回 null ----------
export function parseSpec(spec: unknown, now: number = Date.now()): number | null {
  if (typeof spec !== "string") return null;
  const s = spec.trim();
  if (!s) return null;

  // interval:N —— 每 N 分钟（相对 now 向后排）
  let m = s.match(/^interval:(\d+)$/);
  if (m) {
    const minutes = Number(m[1]);
    if (!Number.isInteger(minutes) || minutes <= 0) return null;
    return now + minutes * 60 * 1000;
  }

  // daily:HHmm —— 每天 HH:mm（本地时区）
  m = s.match(/^daily:(\d{2})(\d{2})$/);
  if (m) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh > 23 || mm > 59) return null;
    const d = new Date(now);
    let at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, mm, 0, 0).getTime();
    if (at <= now) at += 24 * 3600 * 1000; // 今天该时刻已过 → 明天
    return at;
  }

  // cron-lite: "* * * * *"（分 时 日 月 周；每段仅 `*` 或单个数字）
  const fields = s.split(/\s+/);
  if (fields.length !== 5) return null;
  const [minF, hourF, dayF, monthF, dowF] = fields;
  if (![minF, hourF, dayF, monthF, dowF].every((f) => f === "*" || /^\d+$/.test(f))) return null;
  const min = minF === "*" ? null : Number(minF);
  const hour = hourF === "*" ? null : Number(hourF);
  const day = dayF === "*" ? null : Number(dayF);
  const month = monthF === "*" ? null : Number(monthF);
  const dow = dowF === "*" ? null : Number(dowF);
  if (min !== null && min > 59) return null;
  if (hour !== null && hour > 23) return null;
  if (day !== null && (day < 1 || day > 31)) return null;
  if (month !== null && (month < 1 || month > 12)) return null;
  if (dow !== null && dow > 6) return null;

  // 从当前分钟的下一分钟起逐分钟扫描（严格未来，避免刚跑完又立即到期死循环）
  const cursor = new Date(now);
  cursor.setSeconds(0, 0);
  const MAX_SCAN = 366 * 24 * 60; // 最多扫一年（找不到即 null，宽松兜底）
  for (let i = 1; i <= MAX_SCAN; i++) {
    const t = new Date(cursor.getTime() + i * 60 * 1000);
    const hit = (min === null || t.getMinutes() === min)
      && (hour === null || t.getHours() === hour)
      && (day === null || t.getDate() === day)
      && (month === null || (t.getMonth() + 1) === month)
      && (dow === null || t.getDay() === dow);
    if (hit) return t.getTime();
  }
  return null;
}

// ---------- 由 job（含 schedule_spec）算下一次运行时间 ----------
export function computeNextRun(job: { schedule_spec?: unknown } | null | undefined, now: number = Date.now()): number | null {
  return parseSpec(job && job.schedule_spec, now);
}

// ---------- DB 行 ↔ JS job 对象（enabled→bool，config→对象，时间戳→number|null） ----------
function mapRow(row: unknown): ScheduledJob | null {
  if (!row) return null;
  const r = row as Record<string, unknown>;
  let config: Record<string, unknown> = {};
  try { config = r.config ? JSON.parse(String(r.config)) : {}; } catch { /* 脏 JSON 回退空对象 */ }
  return {
    id: String(r.id),
    name: String(r.name),
    job_type: String(r.job_type),
    schedule_spec: String(r.schedule_spec),
    enabled: !!r.enabled,
    config,
    last_run_at: (r.last_run_at as number | null | undefined) ?? null,
    next_run_at: (r.next_run_at as number | null | undefined) ?? null,
    consecutive_failures: (r.consecutive_failures as number | null | undefined) ?? 0,
    created_at: Number(r.created_at),
    updated_at: Number(r.updated_at),
  };
}

function toParams(job: ScheduledJob): unknown[] {
  return [
    job.id,
    job.name,
    job.job_type,
    job.schedule_spec,
    job.enabled ? 1 : 0,
    JSON.stringify(job.config || {}),
    job.last_run_at ?? null,
    job.next_run_at ?? null,
    job.consecutive_failures ?? 0,
    job.created_at,
    job.updated_at,
  ];
}

// ---------- 工厂：createScheduler({ db, now, executes }) ----------
// db: node:sqlite DatabaseSync（须已 ensureSchema，含 scheduled_jobs 表）
// now: 当前时间函数（默认 Date.now），测试可注入固定时钟
// executes: job_type → async fn(job) 返回 { ok, error?, heartbeat? }
export function createScheduler({ db, now = Date.now, executes = {} }: SchedulerOptions): Scheduler {
  const nowFn: () => number = typeof now === "function" ? now : () => Number(now);

  const stmts = {
    all: db.prepare("SELECT * FROM scheduled_jobs ORDER BY created_at ASC, id ASC"),
    byId: db.prepare("SELECT * FROM scheduled_jobs WHERE id = ?"),
    due: db.prepare(
      "SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC, created_at ASC"
    ),
    upsert: db.prepare(`
      INSERT INTO scheduled_jobs
        (id, name, job_type, schedule_spec, enabled, config, last_run_at, next_run_at, consecutive_failures, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        job_type = excluded.job_type,
        schedule_spec = excluded.schedule_spec,
        enabled = excluded.enabled,
        config = excluded.config,
        last_run_at = excluded.last_run_at,
        next_run_at = excluded.next_run_at,
        consecutive_failures = excluded.consecutive_failures,
        updated_at = excluded.updated_at
    `),
    del: db.prepare("DELETE FROM scheduled_jobs WHERE id = ?"),
  };

  function writeJob(job: ScheduledJob): void { stmts.upsert.run(...toParams(job)); }

  function getJob(id: string): ScheduledJob | null { return mapRow(stmts.byId.get(id)); }
  function listJobs(): ScheduledJob[] {
    return stmts.all.all().map(mapRow).filter((j): j is ScheduledJob => !!j);
  }

  function registerJob(job: JobInput): ScheduledJob | null {
    const ts = nowFn();
    const record: ScheduledJob = {
      id: job.id || randomUUID(),
      name: job.name || job.job_type || "job",
      job_type: job.job_type,
      schedule_spec: job.schedule_spec,
      enabled: job.enabled !== false,
      config: job.config || {},
      last_run_at: null,
      next_run_at: computeNextRun({ schedule_spec: job.schedule_spec }, ts),
      consecutive_failures: 0,
      created_at: ts,
      updated_at: ts,
    };
    writeJob(record);
    return getJob(record.id);
  }

  function enableJob(id: string, bool: unknown): ScheduledJob | null {
    const row = stmts.byId.get(id);
    if (!row) return null;
    const cur = mapRow(row) as ScheduledJob;
    const ts = nowFn();
    const enabled = !!bool;
    const record: ScheduledJob = {
      ...cur,
      enabled,
      next_run_at: enabled ? computeNextRun(cur, ts) : null,
      consecutive_failures: enabled ? 0 : cur.consecutive_failures, // 重新启用 → 计数清零
      updated_at: ts,
    };
    writeJob(record);
    return getJob(id);
  }

  function deleteJob(id: string): boolean { return Number(stmts.del.run(id).changes ?? 0) > 0; }

  function updateJob(id: string, patch: JobPatch = {}): ScheduledJob | null {
    const row = stmts.byId.get(id);
    if (!row) return null;
    const cur = mapRow(row) as ScheduledJob;
    const ts = nowFn();
    const next: ScheduledJob = { ...cur };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.job_type !== undefined) next.job_type = patch.job_type;
    if (patch.schedule_spec !== undefined) next.schedule_spec = patch.schedule_spec;
    if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
    if (patch.config !== undefined) next.config = patch.config;
    next.updated_at = ts;
    // 排程变化 / 重新启用 → 重算 next_run_at；显式禁用 → 清空
    if (patch.schedule_spec !== undefined || (patch.enabled === true && !cur.enabled)) {
      next.next_run_at = next.enabled ? computeNextRun(next, ts) : null;
    } else if (patch.enabled === false) {
      next.next_run_at = null;
    }
    if (patch.enabled === true && !cur.enabled) next.consecutive_failures = 0;
    writeJob(next);
    return getJob(id);
  }

  // 单个任务执行：成功/失败/心跳三种结局，各自落库
  async function runOne(job: ScheduledJob, now: number): Promise<RunOutcome> {
    const execute = executes[job.job_type];
    if (typeof execute !== "function") {
      return { id: job.id, ok: true, skipped: "no-executor" }; // 无执行器：不动状态，交给下次 tick（幂等跳过）
    }
    let result: JobResult;
    let thrown: string | null = null;
    try {
      result = await execute(job);
    } catch (e) {
      thrown = e && (e as Error).message ? (e as Error).message : String(e);
      result = { ok: false };
    }

    // HEARTBEAT_OK：未完成但存活 → 不计失败、不重置、last_run_at 不动，短时后重试
    const heartbeat = result === HEARTBEAT_OK
      || (!!result && typeof result === "object" && (result.heartbeat === true || result.heartbeat === HEARTBEAT_OK));
    if (heartbeat) {
      writeJob({ ...job, next_run_at: now + HEARTBEAT_RETRY_MS, updated_at: now });
      return { id: job.id, ok: false, heartbeat: true };
    }

    const ok = !!(result && (result as { ok?: boolean }).ok !== false);
    if (ok) {
      writeJob({
        ...job,
        last_run_at: now,
        next_run_at: computeNextRun(job, now),
        consecutive_failures: 0,
        updated_at: now,
      });
      return { id: job.id, ok: true };
    }

    // 失败：计数 +1；连续 ≥阈值 → 自动禁用并在 config 记原因
    const failures = (job.consecutive_failures ?? 0) + 1;
    const disabled = failures >= AUTO_DISABLE_AFTER;
    const error = (result && typeof result === "object" && result.error) || thrown;
    const config: Record<string, unknown> = { ...(job.config || {}) };
    if (disabled) {
      config.disabled_reason = error || "连续失败自动禁用";
      config.disabled_at = now;
    }
    writeJob({
      ...job,
      config,
      last_run_at: now,
      consecutive_failures: failures,
      enabled: disabled ? false : job.enabled,
      next_run_at: disabled ? null : computeNextRun(job, now),
      updated_at: now,
    });
    return { id: job.id, ok: false, error, failures, disabled };
  }

  let running = false; // 重入保护：上一轮未跑完则跳过本次 tick（避免 60s tick 与慢任务重叠）

  async function checkDue(now: number = nowFn()): Promise<RunOutcome[]> {
    if (running) return [];
    running = true;
    const results: RunOutcome[] = [];
    try {
      let due: ScheduledJob[] = [];
      try { due = stmts.due.all(now).map(mapRow).filter((j): j is ScheduledJob => !!j); } catch { return []; }
      for (const job of due) {
        try {
          results.push(await runOne(job, now));
        } catch (e) {
          results.push({ id: job.id, ok: false, error: e && (e as Error).message ? (e as Error).message : String(e) });
        }
      }
    } finally {
      running = false;
    }
    return results;
  }

  return {
    registerJob,
    listJobs,
    getJob,
    enableJob,
    deleteJob,
    updateJob,
    checkDue,
  };
}
