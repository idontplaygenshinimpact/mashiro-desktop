// 牛客大厂官方真题搜集：公司真题页（exam/company）→ 历年笔试试卷清单 → 入库 + 进 RAG 知识库
// 真题由企业提供（牛客官方收录历年真实笔试试卷），免登录可看清单/题型分布，完整题目需登录（牛客免费申请练习）
// 登录态：用户提供牛客 Cookie（data/nowcoder-cookie.json，本地保存不入 git），Playwright 注入抓题
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { db } from "./db.mjs";

const COOKIE_FILE = path.join(import.meta.dirname, "..", "data", "nowcoder-cookie.json");

db.exec(`
CREATE TABLE IF NOT EXISTS exam_papers (
  id TEXT PRIMARY KEY,
  kind TEXT DEFAULT 'real',  -- real=大厂真题 / simulate=平台模拟卷
  company TEXT,           -- 公司名（从标题提取）
  title TEXT,             -- 试卷标题（公司+场次）
  test_id TEXT,           -- 牛客 testId（URL 中数字）
  url TEXT,               -- 试卷 summary 页
  question_count INTEGER, -- 总题量（详情抓取后填充）
  single_count INTEGER,   -- 单选题数
  multi_count INTEGER,    -- 多选题数
  program_count INTEGER,  -- 编程题数
  job_tags TEXT,          -- 匹配职位（JSON 数组）
  found_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exam_company ON exam_papers(company);
CREATE INDEX IF NOT EXISTS idx_exam_kind ON exam_papers(kind);
CREATE TABLE IF NOT EXISTS exam_questions (
  id TEXT PRIMARY KEY,
  paper_test_id TEXT,     -- 所属试卷 testId
  q_index INTEGER,        -- 题号
  q_type TEXT,            -- single/multi/program/judge
  title TEXT,             -- 题干
  options TEXT,           -- 选项 JSON（选择类）
  answer TEXT,            -- 参考答案（如有）
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_exam_q_paper ON exam_questions(paper_test_id);
`);
// 迁移：旧表补 kind 列
try { db.exec("ALTER TABLE exam_papers ADD COLUMN kind TEXT DEFAULT 'real'"); } catch { /* 列已存在 */ }

/** 保存牛客 Cookie（用户浏览器复制 Cookie 头字符串，本地落盘不入 git） */
export function saveNowcoderCookie(cookieStr) {
  const s = String(cookieStr || "").trim();
  if (!s) return { ok: false, error: "Cookie 为空" };
  const pairs = [];
  for (const seg of s.split(";")) {
    const idx = seg.indexOf("=");
    if (idx <= 0) continue;
    pairs.push({ name: seg.slice(0, idx).trim(), value: seg.slice(idx + 1).trim() });
  }
  if (!pairs.length) return { ok: false, error: "Cookie 格式无法解析（应为 name=value; name2=value2 形式）" };
  writeFileSync(COOKIE_FILE, JSON.stringify({ pairs, savedAt: Date.now(), source: "user" }), "utf8");
  return { ok: true, count: pairs.length };
}

export function getNowcoderCookie() {
  try {
    if (!existsSync(COOKIE_FILE)) return null;
    const j = JSON.parse(readFileSync(COOKIE_FILE, "utf8"));
    return j?.pairs?.length ? j.pairs : null;
  } catch { return null; }
}

/**
 * 登录态抓取试卷完整题目：注入 Cookie → 打开试卷 → 点开始答题 → 逐题提取 → 入库 exam_questions
 * @param {string} paperTestId 试卷 testId
 * @returns {Promise<{ok:boolean, questions:Array, error?:string}>}
 */
export async function fetchPaperQuestions(paperTestId) {
  const cookiePairs = getNowcoderCookie();
  if (!cookiePairs) return { ok: false, questions: [], error: "未配置牛客 Cookie——面板「配置 Cookie」粘贴浏览器登录后的 Cookie 头" };
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"] });
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    locale: "zh-CN",
  });
  try {
    // 注入 Cookie（domain 覆盖 .nowcoder.com）
    await ctx.addCookies(cookiePairs.map((c) => ({
      name: c.name, value: c.value, domain: ".nowcoder.com", path: "/",
    })));
    const page = await ctx.newPage();
    await page.goto(`https://www.nowcoder.com/exam/test/${paperTestId}/summary`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(2500);
    // 已登录判定：无"登录/注册"链接
    const loggedIn = !(await page.locator("text=登录 / 注册").count());
    if (!loggedIn) return { ok: false, questions: [], error: "Cookie 无效或已过期——请重新在浏览器登录牛客后复制新 Cookie" };
    // 点"开始答题"进入答题页
    await page.locator("text=开始答题").first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(3500);
    // 提取题目：题干/选项/类型（牛客答题页 DOM）
    const questions = await page.evaluate(() => {
      const out = [];
      const blocks = Array.from(document.querySelectorAll(".question-box, .question-content, [class*=question]"))
        .filter((el) => (el.textContent || "").trim().length > 20);
      for (const el of blocks) {
        const t = (el.textContent || "").trim();
        const type = /多选/.test(t) ? "multi" : /编程/.test(t) ? "program" : "single";
        out.push({ title: t.slice(0, 2000), type });
      }
      return out;
    });
    return { ok: questions.length > 0, questions, error: questions.length ? undefined : "未能提取到题目（答题页结构可能变化或需进一步交互）" };
  } finally {
    await browser.close();
  }
}

// 目标大厂名单（技术岗求职者关注）
const TARGET_COMPANIES = [
  "字节", "腾讯", "阿里", "美团", "京东", "百度", "华为", "网易", "快手", "小米",
  "拼多多", "携程", "联想", "bilibili", "哔哩哔哩", "小红书", "OPPO", "vivo", "中兴",
  "SHEIN", "米哈游", "得物", "360", "滴滴", "顺丰", "TCL", "海康", "大疆", "用友",
];
// 技术岗关键词（过滤银行/运营商/综合类模拟卷）
const TECH_RE = /研发|开发|技术|算法|编程|前端|后端|AI|客户端|测试|数据|工程|软开|Java|C\+\+|iOS|Android/;
// 非技术类排除（"测试"会误伤"综合能力测试"）
const NON_TECH_TITLE_RE = /产品|运营|市场|营销|销售|管理培训|管培|职能|财务|人力/;

function clean(s, max) { return String(s || "").trim().slice(0, max || 100); }

function extractCompany(title) {
  for (const c of TARGET_COMPANIES) {
    if (title.includes(c)) return c === "bilibili" || c === "哔哩哔哩" ? "bilibili" : c;
  }
  return "";
}

/** 收集真题/模拟卷清单：抓公司真题页 → 双轨收录（大厂技术真题 + 平台模拟卷）→ 入库（去重：testId） */
export async function collectZhentiList() {
  const { fetchPage } = await import("./fetch-page.mjs");
  const page = await fetchPage("https://www.nowcoder.com/exam/company?questionJobId=10&subTabName=written_page", {
    maxTextChars: 400,
    collectLinks: true,
    waitMs: 4000, // SPA 渲染等待
  });
  const now = Date.now();
  let added = 0, dup = 0, skipped = 0;
  const out = [];
  for (const l of page.links || []) {
    const m = String(l.href || "").match(/\/exam\/test\/(\d+)\/summary/);
    if (!m) continue;
    const title = clean(l.text, 120);
    const isSimulate = /模拟/.test(title); // 平台模拟卷（中厂笔试同源公共题）
    const company = extractCompany(title);
    // 收录规则：大厂技术真题 或 平台模拟卷；其余（银行非模拟/其他公司）排除
    if (!company && !isSimulate) { skipped++; continue; }
    if (!isSimulate && !TECH_RE.test(title)) { skipped++; continue; }
    if (!isSimulate && NON_TECH_TITLE_RE.test(title)) { skipped++; continue; }
    const kind = isSimulate ? "simulate" : "real";
    const dupRow = db.prepare("SELECT id FROM exam_papers WHERE test_id=?").get(m[1]);
    if (dupRow) { dup++; continue; }
    const id = `ex_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    db.prepare("INSERT INTO exam_papers (id, kind, company, title, test_id, url, found_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, kind, company, title, m[1], `https://www.nowcoder.com/exam/test/${m[1]}/summary`, now, now);
    added++;
    out.push({ kind, company, title });
  }
  return { total: page.links?.length || 0, added, dup, skipped, papers: out };
}

/**
 * 真题清单（可按公司/类型过滤）
 * @param {Object} [opts]
 * @param {string} [opts.company] 公司名过滤
 * @param {string} [opts.kind] real/simulate 过滤
 * @param {number} [opts.limit]
 */
export function getZhentiList({ company, kind, limit = 200 } = {}) {
  const conds = [];
  const args = [];
  if (company) { conds.push("company=?"); args.push(company); }
  if (kind) { conds.push("kind=?"); args.push(kind); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT * FROM exam_papers ${where} ORDER BY updated_at DESC LIMIT ?`).all(...args, limit);
  return rows.map((r) => ({
    id: String(r.id),
    kind: String(r.kind || "real"),
    company: String(r.company),
    title: String(r.title),
    url: String(r.url),
    questionCount: r.question_count || 0,
    singleCount: r.single_count || 0,
    multiCount: r.multi_count || 0,
    programCount: r.program_count || 0,
    jobTags: (() => { try { return JSON.parse(String(r.job_tags || "[]")); } catch { return []; } })(),
  }));
}

export function getZhentiStats() {
  const total = db.prepare("SELECT COUNT(*) n FROM exam_papers").get().n;
  const byKind = db.prepare("SELECT kind, COUNT(*) n FROM exam_papers GROUP BY kind").all();
  const byCompany = db.prepare("SELECT company, COUNT(*) n FROM exam_papers WHERE kind='real' GROUP BY company ORDER BY n DESC").all();
  return { total, byKind, byCompany };
}

// summary 页解析：总题量/单选题/多选题/编程题/匹配职位
const Q_COUNT_RE = /总题量[|｜:\s]*(\d+)|单选题[|｜:\s]*(\d+)|多选题[|｜:\s]*(\d+)|编程题[|｜:\s]*(\d+)/g;

/**
 * 错题回流：真题练习做错的题 → 学习清单（必会 + 验证题）+ FSRS 复习卡
 * 学习闭环：练习错题 → 下次生成清单优先覆盖 → 复习卡到期自动提醒
 */
export async function addWrongQuestion({ paperId, company, paperTitle, question, answer }) {
  const { addPlanItems } = await import("./study.mjs");
  const { review } = await import("./review.mjs");
  const title = clean(paperTitle, 40);
  const topic = `真题错题·${company || "笔试"}` + (title ? `·${title.slice(0, 16)}` : "");
  // 1) 学习清单（必会，验证题=题干，学习闭环优先覆盖）
  const r = addPlanItems([{
    topic,
    why: `牛客官方真题练习错题（试卷 ${paperId || "?"}），需优先补强`,
    source: "牛客真题",
    verify_question: clean(question, 200) || `请完整回答并讲清原理：${topic}`,
    level: "必会",
  }]);
  // 2) FSRS 复习卡（答错起点，到期自动提醒复习）
  review.addCard({
    topic,
    question: clean(question, 300),
    answer: clean(answer, 500),
    source: "牛客真题",
  });
  return { ok: true, added: r?.added || 0, topic };
}

/** 抓取试卷详情（题型分布 + 匹配职位）——并行抓前 limit 个缺详情的 */
export async function collectZhentiDetails(limit = 20) {
  const { fetchPage } = await import("./fetch-page.mjs");
  const rows = db.prepare("SELECT id, url FROM exam_papers WHERE question_count IS NULL ORDER BY found_at DESC LIMIT ?").all(limit);
  const results = [];
  await Promise.all(
    rows.map(async (r) => {
      try {
        const page = await fetchPage(r.url, { maxTextChars: 2000, waitMs: 3000 });
        const text = page.text || "";
        const nums = { question: 0, single: 0, multi: 0, program: 0 };
        for (const m of text.matchAll(Q_COUNT_RE)) {
          // 交替分支各自捕获（m[1]=总题量 m[2]=单选 m[3]=多选 m[4]=编程）
          if (m[0].includes("总题量")) nums.question = parseInt(m[1], 10) || 0;
          else if (m[0].includes("单选题")) nums.single = parseInt(m[2], 10) || 0;
          else if (m[0].includes("多选题")) nums.multi = parseInt(m[3], 10) || 0;
          else if (m[0].includes("编程题")) nums.program = parseInt(m[4], 10) || 0;
        }
        const jobM = text.match(/匹配职位[\s\S]{0,200}/);
        const jobTags = jobM ? (jobM[0].match(/[\u4e00-\u9fffA-Za-z+]+工程师|[\u4e00-\u9fffA-Za-z+]+岗/g) || []).slice(0, 12) : [];
        db.prepare("UPDATE exam_papers SET question_count=?, single_count=?, multi_count=?, program_count=?, job_tags=?, updated_at=? WHERE id=?")
          .run(nums.question, nums.single, nums.multi, nums.program, JSON.stringify(jobTags), Date.now(), String(r.id));
        results.push({ id: String(r.id), ...nums, jobTags });
      } catch (e) {
        results.push({ id: String(r.id), error: e.message.slice(0, 60) });
      }
    })
  );
  return results;
}
