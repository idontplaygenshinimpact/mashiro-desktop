// 牛客专项练习（OJ 题库）：面试 TOP101 高频算法题清单抓取 + 查询
// 练习入口：https://www.nowcoder.com/exam/oj?tab=面试TOP101（免登录，无时间窗，随时可刷）
// 抓取：页面 innerText + .question-tree-row 结构化提取（BM 编号/标题/难度/通过量/链接）
import { db } from "./db.mjs";
import { assertPublicUrl } from "./fetch-page.mjs"; // 安全工单 L10：内部抓取复用 SSRF 防护

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

/**
 * 抓取 TOP101 题目清单（幂等 upsert：按 分类+BM编号 去重更新）
 * @returns {Promise<{ok:boolean, total:number, added:number, updated:number, error?:string}>}
 */
export async function collectOjProblems() {
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
    const problems = await page.evaluate(() => {
      const out = [];
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
              href: /** @type {HTMLAnchorElement} */ (a).href,
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

/**
 * 题目清单（可按分类/难度过滤）
 * @param {Object} [opts]
 * @param {string} [opts.category]
 * @param {string} [opts.difficulty]
 * @param {number} [opts.limit]
 */
export function getOjProblems({ category, difficulty, limit = 200 } = {}) {
  const conds = [];
  const args = [];
  if (category) { conds.push("category=?"); args.push(category); }
  if (difficulty) { conds.push("difficulty LIKE ?"); args.push(`${difficulty}%`); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT category, bm_no, title, difficulty, people, url FROM exam_problems
    ${where} ORDER BY category, bm_no LIMIT ?`).all(...args, limit);
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
export function getOjStats() {
  const total = db.prepare("SELECT COUNT(*) n FROM exam_problems").get().n;
  const byCategory = db.prepare("SELECT category, COUNT(*) n FROM exam_problems GROUP BY category ORDER BY n DESC").all()
    .map((r) => ({ category: String(r.category), count: r.n }));
  const byDifficulty = db.prepare("SELECT difficulty, COUNT(*) n FROM exam_problems GROUP BY difficulty").all()
    .map((r) => ({ difficulty: String(r.difficulty), count: r.n }));
  return { total, byCategory, byDifficulty };
}

// ---------- 刷题进度（闭环：刷过的题计入学习统计/建议，settings JSON 持久化） ----------
const PROGRESS_KEY = "oj_progress";

/** 已刷题目列表 [{key, title, category, doneAt}] */
export function getOjProgress() {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PROGRESS_KEY);
    if (row?.value != null) {
      const parsed = JSON.parse(String(row.value));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return Object.entries(parsed).map(([key, v]) => ({
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
export function markOjDone({ bm_no, title, category }) {
  const key = String(bm_no || title || "").trim();
  if (!key) return { ok: false, error: "缺少题目标识" };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(PROGRESS_KEY);
    const map = {};
    try { if (row?.value != null) Object.assign(map, JSON.parse(String(row.value))); } catch { /* ignore */ }
    map[key] = { title: String(title || key).slice(0, 60), category: String(category || ""), doneAt: Date.now() };
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(PROGRESS_KEY, JSON.stringify(map), Date.now());
    return { ok: true, done: Object.keys(map).length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- 题目内容本地化（按需懒抓 + 缓存） ----------
// 详情页（/practice/xxx）→ 题干/元信息/示例 → 存 exam_problems.content/meta/samples
function ensureDetailColumns() {
  try {
    db.exec("ALTER TABLE exam_problems ADD COLUMN content TEXT DEFAULT ''");
    db.exec("ALTER TABLE exam_problems ADD COLUMN meta TEXT DEFAULT ''");
    db.exec("ALTER TABLE exam_problems ADD COLUMN samples TEXT DEFAULT ''");
    db.exec("ALTER TABLE exam_problems ADD COLUMN fetched_at INTEGER DEFAULT 0");
  } catch { /* 列已存在 */ }
}
ensureDetailColumns();

/**
 * 解析详情页 innerText → { meta, description, samples }
 * 结构：页面顶部是"预览卡"（无"描述"锚点），正式题目区从"描述"行开始，
 * 示例块为 "示例N / 输入(值) / 输出或返回值(值) / 说明(值)"（值为独立行，需收集延续行）
 */
export function parseOjDetail(text) {
  const lines = String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
  const out = { meta: "", description: "", samples: [] };
  let descStarted = false, descSeen = false;
  let descLines = [];
  let curSample = null;

  // 字段值收集：从 start+1 开始收行，直到下一个锚点/字段/限制行
  const collectValue = (start) => {
    const vals = [];
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
    if (fieldM) {
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
async function fetchOjDetailWithBrowser(browser, url) {
  const href = String(url || "").trim();
  if (!href) return { ok: false, error: "url required" };
  // 安全工单 L10：内部抓取复用 assertPublicUrl（防题库 URL 被污染为内网/文件协议）
  try { await assertPublicUrl(href); } catch (e) { return { ok: false, error: `URL 非法: ${e.message}` }; }
  const row = db.prepare("SELECT content, meta, samples, fetched_at FROM exam_problems WHERE url=?").get(href);
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

/**
 * 抓取单题详情（懒加载）：详情页 → 解析 → 入库缓存 → 返回
 * @param {string} url 题目页 URL（/practice/xxx）
 * @returns {Promise<{ok:boolean, content?:string, meta?:string, samples?:string, cached?:boolean, error?:string}>}
 */
export async function fetchOjDetail(url) {
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
 * @param {(done:number, total:number, title:string) => void} [onProgress]
 * @returns {Promise<{ok:boolean, total:number, done:number, failed:number, allCached?:boolean}>}
 */
export async function collectAllOjDetails(onProgress = null) {
  const pending = db.prepare("SELECT url, title FROM exam_problems WHERE fetched_at=0 OR content=''").all();
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
