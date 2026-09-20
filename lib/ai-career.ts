// 手写/算法题库（ai-career 导入）：本地判题闭环
// 数据：challenges 表（scripts/import-ai-career.mjs 导入 D:\ai-career 的 91 道题）
// 判题：worker_threads 沙箱执行 用户代码 + 测试代码（__test__/__assert__/__sleep__ 格式，与 ai-career 同构）
// 闭环：通过 → 学习进度 + done 标记；失败 → 薄弱点回流 + 自动建复习卡；loopSuggest 统计与建议
// 全量 TS 升级工单阶段 3：lib/ai-career.mjs → .ts（tools/loop/插件路由/import 脚本/tests 按 .mjs 路径加载 → 保留同名一行桶）
import { db } from "./db.mjs";
import { memory } from "./memory.mjs";
import { review } from "./review.mjs";
import { challengeTopicFor } from "./study-plan.ts"; // 题目 → 清单/卡片 topic 的单一来源（笔试题·/算法题·/手写题·）

const SANDBOX_TIMEOUT_MS = 15000; // 总超时（同步死循环 + 异步不 resolve 都掐）

/** 导入数据行（ai-career 题库 JSON 的结构） */
export interface ChallengeImportItem {
  id?: unknown;
  title?: unknown;
  category?: unknown;
  difficulty?: unknown;
  frequency?: unknown;
  timeLimit?: unknown;
  description?: unknown;
  skeleton?: unknown;
  testCode?: unknown;
  source?: unknown;
  /** 判题模式：core（默认，LeetCode 核心代码）/ acm（标准输入输出） */
  mode?: unknown;
  /** ACM 用例：[{input, expected}]（mode='acm' 时必填；也可传 JSON 字符串） */
  ioCases?: unknown;
}
/** 题目列表行（含用户状态） */
export interface ChallengeRow {
  id: string;
  title: string;
  category: string;
  difficulty: number;
  frequency: number;
  timeLimit: number;
  description: string;
  skeleton: string;
  /** 判题模式：core / acm（列表页据此分组与展示"ACM 模式"徽标） */
  mode: string;
  /** 能否自动判题：core 看有没有 test_code、acm 看有没有 io_cases。
   *  为什么需要：真实库 448 道 core 题里 **167 道没有 test_code**（链表/树题与参数不可解析的题，
   *  实测 scripts/gen-challenge-tests.mjs 对它们可生成 0 条）——此前面板照样给「▶ 运行判题」，
   *  点了必然失败，用户以为"自己写错了"。现在如实标记，面板改为明确提示（2026-09-16）。 */
  judgeable: boolean;
  done: boolean;
  wrongCount: number;
}
/** ACM 用例（标准输入输出判题） */
export interface ChallengeIoCase { input: string; expected: string }
/** 单题详情（含 test_code / ACM 用例） */
export interface ChallengeDetail extends ChallengeRow { testCode: string; ioCases: ChallengeIoCase[] }
/** 沙箱判题结果 */
export interface ChallengeRunResult {
  success: boolean;
  /** ACM 模式下带逐用例 diff（input/expected/actual） */
  tests: Array<{ passed: boolean; label: string; input?: string; expected?: string; actual?: string }>;
  logs: string[];
  error: string | null;
  durationMs: number;
}

/** io_cases 列的 JSON 解析（坏数据不抛：返回空数组，判题侧会明确报"缺少用例"） */
export function parseIoCases(raw: unknown): ChallengeIoCase[] {
  if (Array.isArray(raw)) return raw.map((c) => ({ input: String((c as { input?: unknown })?.input ?? ""), expected: String((c as { expected?: unknown })?.expected ?? "") }));
  const s = String(raw ?? "").trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    return Array.isArray(j) ? j.map((c) => ({ input: String(c?.input ?? ""), expected: String(c?.expected ?? "") })) : [];
  } catch { return []; }
}

// ---------- 导入（由 scripts/import-ai-career.mjs / import-codetop-top400.mjs 调用） ----------
/**
 * 批量导入题目（幂等覆盖：内容列刷新，用户做题状态保留）
 * 修复：INSERT OR REPLACE 整行重建 → 重跑导入清零 done/done_at/wrong_count（做题进度丢失）。
 * 改 ON CONFLICT DO UPDATE 只刷内容列，兑现 import-codetop-top400.mjs"幂等覆盖"承诺。
 */
export function importChallengesData(list: unknown): { ok: boolean; imported?: number; error?: string } {
  if (!Array.isArray(list) || !list.length) return { ok: false, error: "空数据" };
  const ins = db.prepare(`INSERT INTO challenges
    (id, title, category, difficulty, frequency, time_limit, description, skeleton, test_code, mode, io_cases, source, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      category = excluded.category,
      difficulty = excluded.difficulty,
      frequency = excluded.frequency,
      time_limit = excluded.time_limit,
      description = excluded.description,
      skeleton = excluded.skeleton,
      test_code = excluded.test_code,
      mode = excluded.mode,
      io_cases = excluded.io_cases,
      source = excluded.source`);
  const now = Date.now();
  let n = 0;
  for (const raw of list as ChallengeImportItem[]) {
    const c = raw;
    if (!c?.id || !c?.title) continue;
    const mode = c.mode === "acm" ? "acm" : "core";
    const ioCases = mode === "acm"
      ? JSON.stringify(parseIoCases(c.ioCases).filter((x) => x.expected !== "" || x.input !== ""))
      : "";
    ins.run(
      String(c.id), String(c.title).slice(0, 100),
      c.category === "algorithm" ? "algorithm" : "handwrite",
      Number(c.difficulty) || 1, Number(c.frequency) || 1, Number(c.timeLimit) || 10,
      String(c.description || "").slice(0, 6000),
      String(c.skeleton || ""), String(c.testCode || ""), mode, ioCases, String(c.source || "ai-career"), now
    );
    n++;
  }
  return { ok: true, imported: n };
}

// ---------- 查询 ----------
/** 题目列表（含用户状态：done/wrong_count；mode 决定前端是否按 ACM 模式展示） */
export function getChallenges({ category = "", difficulty = 0, done = null, mode = "" }: { category?: string; difficulty?: number; done?: boolean | null; mode?: string } = {}): ChallengeRow[] {
  const conds: string[] = [];
  const args: Array<string | number> = [];
  if (category) { conds.push("category=?"); args.push(category); }
  if (difficulty) { conds.push("difficulty=?"); args.push(Number(difficulty)); }
  if (done !== null) { conds.push("done=?"); args.push(done ? 1 : 0); }
  if (mode) { conds.push("mode=?"); args.push(String(mode)); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  return (db.prepare(`SELECT id, title, category, difficulty, frequency, time_limit, description, skeleton,
    mode, test_code, io_cases, done, wrong_count FROM challenges ${where} ORDER BY mode, category, difficulty, frequency DESC, id`).all(...args) as Array<Record<string, unknown>>)
    .map((r) => ({
      id: String(r.id), title: String(r.title), category: String(r.category),
      difficulty: Number(r.difficulty), frequency: Number(r.frequency), timeLimit: Number(r.time_limit),
      description: String(r.description || ""), skeleton: String(r.skeleton || ""),
      mode: String(r.mode || "core"),
      judgeable: String(r.mode || "core") === "acm" ? parseIoCases(r.io_cases).length > 0 : String(r.test_code || "").trim().length > 0,
      done: !!r.done, wrongCount: Number(r.wrong_count || 0),
    }));
}

/** 单题详情（含 test_code 与 ACM 用例，供判题页加载） */
export function getChallengeDetail(id: unknown): ChallengeDetail | null {
  const r = db.prepare(`SELECT id, title, category, difficulty, frequency, time_limit, description, skeleton, test_code,
    mode, io_cases, done, wrong_count FROM challenges WHERE id=?`).get(String(id)) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    id: String(r.id), title: String(r.title), category: String(r.category),
    difficulty: Number(r.difficulty), frequency: Number(r.frequency), timeLimit: Number(r.time_limit),
    description: String(r.description || ""), skeleton: String(r.skeleton || ""),
    testCode: String(r.test_code || ""), mode: String(r.mode || "core"), ioCases: parseIoCases(r.io_cases),
    // 详情页与列表同一口径（面板据 judgeable 决定是否渲染「▶ 运行判题」）
    judgeable: String(r.mode || "core") === "acm" ? parseIoCases(r.io_cases).length > 0 : String(r.test_code || "").trim().length > 0,
    done: !!r.done, wrongCount: Number(r.wrong_count || 0),
  };
}

/** 题库统计（闭环：done/total + 分类） */
export function getChallengeStats(): { total: number; done: number; byCat: Array<{ category: string; count: unknown }> } {
  const total = Number((db.prepare("SELECT COUNT(*) n FROM challenges").get() as { n?: unknown } | undefined)?.n || 0);
  const done = Number((db.prepare("SELECT COUNT(*) n FROM challenges WHERE done=1").get() as { n?: unknown } | undefined)?.n || 0);
  const byCat = (db.prepare("SELECT category, COUNT(*) n FROM challenges GROUP BY category").all() as Array<Record<string, unknown>>)
    .map((r) => ({ category: String(r.category), count: r.n }));
  return { total, done, byCat };
}

// ---------- 判题沙箱（worker_threads 隔离——vm 不是安全边界，见 sandbox-runner.ts） ----------
/** 从骨架提取导出名（function/class/var X = function 名列表） */
export function buildExportArgs(skeleton: unknown): string {
  const names: string[] = [];
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*function\s+(\w+)/g)) names.push(m[1]);
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*class\s+(\w+)/g)) names.push(m[1]);
  // LeetCode 骨架格式：`var isValid = function(...)`（修复：原实现不匹配 → 生成的测试码无法判题）
  for (const m of String(skeleton || "").matchAll(/(?:^|\n)\s*var\s+(\w+)\s*=\s*(?:async\s+)?function/g)) names.push(m[1]);
  return [...new Set(names)].join(", ");
}

/**
 * 沙箱判题：用户代码 + 测试代码在独立 worker 线程（vm 双隔离）执行，超时真正终止
 * @param mode core=LeetCode 核心代码（默认，testCode 走 __test__ 断言）；acm=标准输入输出（cases 逐组比对）
 */
export async function runChallengeCode({ userCode, testCode = "", skeleton, mode = "core", cases = [], timeoutMs = SANDBOX_TIMEOUT_MS }: { userCode: string; testCode?: string; skeleton?: string; mode?: string; cases?: ChallengeIoCase[]; timeoutMs?: number }): Promise<ChallengeRunResult> {
  const start = Date.now();
  try {
    const { runInSandbox } = await import("./sandbox-runner.ts");
    const r = await runInSandbox({
      userCode, testCode, skeleton,
      mode: mode === "acm" ? "acm" : "core",
      cases: Array.isArray(cases) ? cases : [],
      timeoutMs,
    }) as { success?: unknown; tests?: unknown; logs?: unknown; error?: unknown };
    return {
      success: !!r.success,
      tests: Array.isArray(r.tests) ? r.tests as ChallengeRunResult["tests"] : [],
      logs: Array.isArray(r.logs) ? (r.logs as unknown[]).map((l) => String(l)) : [],
      error: r.error ? String(r.error) : null,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      success: false, tests: [], logs: [],
      error: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - start,
    };
  }
}

// ---------- 闭环回流 ----------
/** 标记通过：done + 学习进度回流（可选手动标记） */
export function markChallengeDone(id: unknown, { progress = true }: { progress?: boolean } = {}): { ok: boolean; title?: string; error?: string } {
  const row = db.prepare("SELECT title FROM challenges WHERE id=?").get(String(id)) as { title?: unknown } | undefined;
  if (!row) return { ok: false, error: `题目不存在: ${String(id)}` };
  db.prepare("UPDATE challenges SET done=1, done_at=? WHERE id=?").run(Date.now(), String(id));
  if (progress) {
    try { memory.recordProgress(String(row.title), "done"); } catch { /* 回流失败不影响标记 */ }
  }
  return { ok: true, title: String(row.title) };
}

/** 记录一次失败：wrong_count+1 + 薄弱点回流 + 自动建 FSRS 复习卡（到期提醒复习，闭环） */
export function markChallengeWrong(id: unknown): { ok: boolean; title?: string; error?: string } {
  const row = db.prepare("SELECT title, category, mode FROM challenges WHERE id=?").get(String(id)) as { title?: unknown; category?: unknown; mode?: unknown } | undefined;
  if (!row) return { ok: false, error: `题目不存在: ${String(id)}` };
  db.prepare("UPDATE challenges SET wrong_count = wrong_count + 1 WHERE id=?").run(String(id));
  try {
    memory.addWeakPoint(String(row.title), "手写题练习", "agent", { question: String(row.title) });
  } catch { /* 回流失败不影响计数 */ }
  // 答错自动进复习卡（FSRS 遗忘曲线；带题目 id → 卡片按 id 认亲，标题相似也不会串题）
  try {
    const r = review.addCard({
      // 前缀按题目形态/类目走（2026-09-16 修）：原先写死「手写题·」——ACM 笔试题答错也会被标成"手写题"，
      // 且与清单里的「笔试题·X」对不上；现在统一用 challengeTopicFor（笔试题/算法题/手写题）
      topic: challengeTopicFor(String(row.title), row.mode, row.category),
      question: `请完整实现并讲清原理：${String(row.title)}（不会时回「专项练习」重做该题）`,
      answer: "",
      source: String(row.mode || "") === "acm" ? "ACM 笔试题库" : "手写题库",
      challengeId: String(id),
    }) as { ok?: boolean; topic?: unknown } | null | undefined;
    if (r && r.ok === false) console.warn(`[ai-career] 复习卡建卡失败: ${String(r.topic)}`);
  } catch { /* 回流失败不影响计数 */ }
  return { ok: true, title: String(row.title) };
}
