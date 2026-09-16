// 牛客专项练习（OJ 题库）：面试 TOP101 高频算法题清单抓取 + 查询
// 练习入口：https://www.nowcoder.com/exam/oj?tab=面试TOP101（免登录，无时间窗，随时可刷）
// 抓取：页面 innerText + .question-tree-row 结构化提取（BM 编号/标题/难度/通过量/链接）
// 全量 TS 升级工单阶段 3：lib/oj.mjs → .ts（loop.mjs/context-providers/插件路由/tests 按 .mjs 路径加载 → 保留同名一行桶）
import { db, ensureColumn } from "./db.mjs";
// 安全工单 L10：内部抓取复用 assertPublicUrl（防题库 URL 被污染为内网/文件协议）
// 注意：**不能**静态 import "./fetch-page.mjs"——那条链会拉起 playwright + jsdom（实测 ~1.3s），
// 而 oj 被插件路由静态导入 → 会变成"进程启动即加载浏览器栈"。改为在调用点动态 import（见下方使用处）。

db.exec(`CREATE TABLE IF NOT EXISTS exam_problems (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,        -- 分类（链表/二叉树/动态规划…）
  bm_no TEXT NOT NULL,           -- 节内编号（BM1~BM21，各分类重新计数）
  title TEXT NOT NULL,
  difficulty TEXT DEFAULT '',    -- 入门/简单/中等/较难
  people TEXT DEFAULT '',        -- 通过量（41.2w）
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(category, bm_no)
)`);

const OJ_URL = "https://www.nowcoder.com/exam/oj?tab=%E9%9D%A2%E8%AF%95TOP101";

/** 题目清单行（面板/agent 展示） */
export interface OjProblemRow { category: string; bm_no: string; title: string; difficulty: string; people: string; url: string }
export interface OjCollectResult { ok: boolean; total: number; added: number; updated: number; error?: string }
export interface OjStats { total: number; byCategory: Array<{ category: string; count: unknown }>; byDifficulty: Array<{ difficulty: string; count: unknown }> }
/** 刷题进度条目 */
export interface OjProgressItem { key: string; title: string; category: string; doneAt: number }
/** 示例块 */
export interface OjSample { title: string; input: string; output: string; note: string }
/** parseOjDetail 结果 */
export interface OjDetailParsed { meta: string; description: string; samples: OjSample[] }
/** 单题详情抓取结果 */
export interface OjDetailResult { ok: boolean; content?: string; meta?: string; samples?: string; cached?: boolean; error?: string }

/** 页面结构化提取出的题目（evaluate 返回值） */
interface OjScrapedProblem { category: string; bm_no: string; title: string; difficulty: string; people: string; href: string }

/** 抓取 TOP101 题目清单（幂等 upsert：按 分类+BM编号 去重更新） */
export async function collectOjProblems(): Promise<OjCollectResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
  });
  try {
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      locale: "zh-CN",
    });
    const page = await ctx.newPage();
    await page.goto(OJ_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000); // SPA 渲染等待

    // 结构化提取：分类标题（"02 链表"）+ 题目行（.question-tree-row）
    const problems = await page.evaluate((): OjScrapedProblem[] => {
      const out: OjScrapedProblem[] = [];
      let category = "其他";
      for (const el of Array.from(document.body.querySelectorAll("*"))) {
        const txt = (el.textContent || "").trim();
        // 分类标题：独立短文本（数字+空格+中文，如 "02 链表"），无子链接、非题目行
        if (/^\d{2}\s+\S{2,12}$/.test(txt) && !el.querySelector("a") && !el.classList?.contains("question-tree-row")) {
          category = txt.replace(/^\d{2}\s+/, "").slice(0, 12);
          continue;
        }
        if (el.classList?.contains("question-tree-row")) {
          const bmEl = el.querySelector(".question-no-cell");
          const bm = bmEl ? (bmEl.textContent || "").match(/BM\d+/) : null;
          const a = el.querySelector("a[href*='/practice/']");
          const diff = el.querySelector(".difficulty-cell");
          const ppl = el.querySelector(".people-cell");
          if (bm && a) {
            out.push({
              category,
              bm_no: bm[0],
              title: (a.textContent || "").trim().slice(0, 60),
              difficulty: diff ? (diff.textContent || "").trim().slice(0, 10) : "",
              people: ppl ? (ppl.textContent || "").trim().slice(0, 10) : "",
              href: (a as HTMLAnchorElement).href,
            });
          }
        }
      }
      return out;
    });

    if (!problems.length) return { ok: false, total: 0, added: 0, updated: 0, error: "页面结构变化，未提取到题目" };

    const now = Date.now();
    let added = 0, updated = 0;
    // 全量刷新：TOP101 是固定题库，按 (category,bm_no) upsert 更新结构字段。
    // 注意：不能先 DELETE 再插——fetchOjDetail 懒加载的详情缓存（content/meta/samples/fetched_at）
    // 会随 DELETE 丢失，导致每次刷新后整库重抓（历史 bug：101 页 × 500ms 反爬延迟反复浪费）
    db.exec("BEGIN");
    try {
      const upsert = db.prepare(`INSERT INTO exam_problems (id, category, bm_no, title, difficulty, people, url, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(category, bm_no) DO UPDATE SET
          title=excluded.title, difficulty=excluded.difficulty, people=excluded.people, url=excluded.url, updated_at=excluded.updated_at`);
      for (const p of problems) {
        const existed = db.prepare("SELECT 1 FROM exam_problems WHERE category=? AND bm_no=?").get(p.category, p.bm_no);
        upsert.run(
          `oj_${p.category}_${p.bm_no}`,
          p.category, p.bm_no, p.title, p.difficulty, p.people, p.href,
          now, now,
        );
        if (existed) updated++; else added++;
      }
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }

    return { ok: true, total: problems.length, added, updated };
  } finally {
    await browser.close();
  }
}

/** 题目清单（可按分类/难度过滤） */
export function getOjProblems({ category, difficulty, limit = 200 }: { category?: string; difficulty?: string; limit?: number } = {}): OjProblemRow[] {
  const conds: string[] = [];
  const args: string[] = [];
  if (category) { conds.push("category=?"); args.push(category); }
  if (difficulty) { conds.push("difficulty LIKE ?"); args.push(`${difficulty}%`); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT category, bm_no, title, difficulty, people, url FROM exam_problems
    ${where} ORDER BY category, bm_no LIMIT ?`).all(...args, limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    category: String(r.category),
    bm_no: String(r.bm_no),
    title: String(r.title),
    difficulty: String(r.difficulty || ""),
    people: String(r.people || ""),
    url: String(r.url),
  }));
}

/** 统计：总数/分类分布/难度分布 */
export function getOjStats(): OjStats {
  const totalRow = db.prepare("SELECT COUNT(*) n FROM exam_problems").get() as { n?: unknown } | undefined;
  const byCategory = (db.prepare("SELECT category, COUNT(*) n FROM exam_problems GROUP BY category ORDER BY n DESC").all() as Array<Record<string, unknown>>)
    .map((r) => ({ category: String(r.category), count: r.n }));
  const byDifficulty = (db.prepare("SELECT difficulty, COUNT(*) n FROM exam_problems GROUP BY difficulty").all() as Array<Record<string, unknown>>)
    .map((r) => ({ difficulty: String(r.difficulty), count: r.n }));
  return { total: Number(totalRow?.n) || 0, byCategory, byDifficulty };
}

// ---------- 刷题进度（闭环：刷过的题计入学习统计/建议，settings JSON 持久化） ----------
const PROGRESS_KEY = "oj_progress";

/** 已刷题目列表 [{key, title, category, doneAt}] */
export function getOjProgress(): OjProgressItem[] {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PROGRESS_KEY) as { value?: unknown } | undefined;
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value)) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.entries(parsed as Record<string, { title?: unknown; category?: unknown; doneAt?: unknown }>).map(([key, v]) => ({
          key: String(key),
          title: String(v?.title || key).slice(0, 60),
          category: String(v?.category || ""),
          doneAt: Number(v?.doneAt) || 0,
        }));
      }
    }
  } catch { /* ignore */ }
  return [];
}

/** 标记一题刷完（按 bm_no 或 title 去重） */
export function markOjDone({ bm_no, title, category }: { bm_no?: unknown; title?: unknown; category?: unknown }): { ok: boolean; done?: number; error?: string } {
  const key = String(bm_no || title || "").trim();
  if (!key) return { ok: false, error: "缺少题目标识" };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PROGRESS_KEY) as { value?: unknown } | undefined;
    const map: Record<string, { title: string; category: string; doneAt: number }> = {};
    try { if (row?.value != null) Object.assign(map, JSON.parse(String(row.value))); } catch { /* ignore */ }
    map[key] = { title: String(title || key).slice(0, 60), category: String(category || ""), doneAt: Date.now() };
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(PROGRESS_KEY, JSON.stringify(map), Date.now());
    return { ok: true, done: Object.keys(map).length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---------- 题目内容本地化（按需懒抓 + 缓存） ----------
// 详情页（/practice/xxx）→ 题干/元信息/示例 → 存 exam_problems.content/meta/samples
// 架构 P0-2：统一 ensureColumn 幂等补列（不再散落裸 try/catch）
ensureColumn("exam_problems", "content", "TEXT DEFAULT ''");
ensureColumn("exam_problems", "meta", "TEXT DEFAULT ''");
ensureColumn("exam_problems", "samples", "TEXT DEFAULT ''");
ensureColumn("exam_problems", "fetched_at", "INTEGER DEFAULT 0");

/**
 * 解析详情页 innerText → { meta, description, samples }
 * 结构：页面顶部是"预览卡"（无"描述"锚点），正式题目区从"描述"行开始，
 * 示例块为 "示例N / 输入(值) / 输出或返回值(值) / 说明(值)"（值为独立行，需收集延续行）
 */
export function parseOjDetail(text: unknown): OjDetailParsed {
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const out: OjDetailParsed = { meta: "", description: "", samples: [] };
  let descStarted = false, descSeen = false;
  const descLines: string[] = [];
  let curSample: OjSample | null = null;

  // 字段值收集：从 start+1 开始收行，直到下一个锚点/字段/限制行
  const collectValue = (start: number): string => {
    const vals: string[] = [];
    for (let j = start + 1; j < lines.length && vals.length < 30; j++) {
      const t = lines[j];
      if (/^(示例\d+|输入|输出|返回值|说明|复制|题目列表|题解|讨论|排行|面经|关联企业|关联职位|相似企业真题|登录|注册)[：:]?$/.test(t)) break;
      if (/^(时间限制|空间限制|通过率|知识点)/.test(t)) break;
      vals.push(t);
    }
    return vals.join(" ");
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 元信息行：难度 + 时间/空间限制
    if (/时间限制：\d+秒/.test(line) || (/空间限制：\d+M/.test(line) && /通过率/.test(line))) {
      out.meta = line.slice(0, 120);
      continue;
    }
    if (line === "描述") { descStarted = true; descSeen = true; continue; }
    if (/^示例(\d+)$/.test(line)) {
      descStarted = false;
      if (!descSeen) continue; // 预览卡的示例（在"描述"之前出现），跳过
      const n = parseInt(line.slice(2), 10);
      curSample = { title: `示例${n}`, input: "", output: "", note: "" };
      out.samples.push(curSample);
      continue;
    }
    const fieldM = curSample && line.match(/^(输入|输出|返回值|说明)[：:]?$/);
    if (fieldM && curSample) {
      const val = collectValue(i);
      if (fieldM[1] === "输入") curSample.input = val;
      else if (fieldM[1] === "输出" || fieldM[1] === "返回值") curSample.output = val;
      else curSample.note = val;
      continue;
    }
    // 描述段结束：遇到无关锚点
    if (descStarted && /^(关联企业|关联职位|相似企业真题|题解|讨论|排行|面经|题目列表|登录|注册)/.test(line)) { descStarted = false; continue; }
    if (descStarted) descLines.push(line);
  }
  out.description = descLines.join("\n").slice(0, 4000);
  return out;
}

/** 用指定浏览器抓单题详情（懒加载/批量下载共用；缓存命中直接返回） */
async function fetchOjDetailWithBrowser(browser: import("playwright").Browser, url: unknown): Promise<OjDetailResult> {
  const href = String(url || "").trim();
  if (!href) return { ok: false, error: "url required" };
  // 安全工单 L10：内部抓取复用 assertPublicUrl（防题库 URL 被污染为内网/文件协议）
  // 性能修复：原先静态 `import { assertPublicUrl } from "./fetch-page.mjs"` 会把整条抓取链
  // （playwright + jsdom，实测 ~1.3s）拉进**进程启动**路径（oj 被插件路由静态导入）；改为用时加载。
  try {
    const { assertPublicUrl } = await import("./fetch-page.mjs");
    await assertPublicUrl(href);
  } catch (e) { return { ok: false, error: `URL 非法: ${e instanceof Error ? e.message : String(e)}` }; }
  const row = db.prepare("SELECT content, meta, samples, fetched_at FROM exam_problems WHERE url=?").get(href) as { content?: unknown; meta?: unknown; samples?: unknown; fetched_at?: unknown } | undefined;
  if (row?.fetched_at && (row.content || row.meta)) {
    return { ok: true, content: String(row.content || ""), meta: String(row.meta || ""), samples: String(row.samples || ""), cached: true };
  }
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  try {
    const page = await ctx.newPage();
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(3500);
    // 定位"BMxx 标题"之后的题目正文（页面顶部是题目卡片，含描述/示例）
    const text = await page.evaluate(() => (document.body ? document.body.innerText : "")).catch(() => "");
    const parsed = parseOjDetail(text);
    if (!parsed.description && !parsed.meta) return { ok: false, error: "详情页解析失败（结构变化？）" };
    db.prepare("UPDATE exam_problems SET content=?, meta=?, samples=?, fetched_at=? WHERE url=?")
      .run(parsed.description, parsed.meta, JSON.stringify(parsed.samples), Date.now(), href);
    return { ok: true, content: parsed.description, meta: parsed.meta, samples: JSON.stringify(parsed.samples), cached: false };
  } finally {
    await ctx.close();
  }
}

/** 抓取单题详情（懒加载）：详情页 → 解析 → 入库缓存 → 返回 */
export async function fetchOjDetail(url: string): Promise<OjDetailResult> {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  try {
    return await fetchOjDetailWithBrowser(browser, url);
  } finally {
    await browser.close();
  }
}

/**
 * 批量下载全部未缓存题目的内容（复用同一浏览器，串行 + 延迟防反爬）
 */
export async function collectAllOjDetails(onProgress: ((done: number, total: number, title: string) => void) | null = null): Promise<{ ok: boolean; total: number; done: number; failed: number; allCached?: boolean }> {
  const pending = db.prepare("SELECT url, title FROM exam_problems WHERE fetched_at=0 OR content=''").all() as Array<Record<string, unknown>>;
  if (!pending.length) return { ok: true, total: 0, done: 0, failed: 0, allCached: true };
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  let done = 0, failed = 0;
  try {
    for (const p of pending) {
      try {
        const r = await fetchOjDetailWithBrowser(browser, String(p.url));
        if (r.ok) done++; else failed++;
      } catch { failed++; }
      if (onProgress) onProgress(done + failed, pending.length, String(p.title || ""));
      await new Promise((r) => setTimeout(r, 500)); // 反爬延迟
    }
    return { ok: true, total: pending.length, done, failed };
  } finally {
    await browser.close();
  }
}
