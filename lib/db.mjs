// agent memory 数据库层（node:sqlite 内置，替代 JSON 文件存储）
// 设计参考 OpenClaw memory-core：规范化小表 + origin 溯源列 + WAL + user_version
// 数据域：memory(agent-memory) / study(study-plan) / review(review-cards) / kp(kp-mastery)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
// 测试隔离：MIANSHI_DB_PATH 指向临时库（生产不设置则用默认路径）
const DB_FILE = process.env.MIANSHI_DB_PATH || path.join(DATA_DIR, "mianshi.db");

// 单例数据库（WAL 模式，busy_timeout 5s——OpenClaw 同款配置）
export const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 5000");
db.exec("PRAGMA foreign_keys = ON");

// ---------- 事务 helper（node:sqlite 无内置 transaction 包装） ----------
export function withTx(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---------- schema ----------
export function ensureSchema() {
  db.exec(`
  -- ========== 域 1: agent-memory ==========
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,          -- JSON 字符串（profile/stats/当前interview）
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS interests (
    topic TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seen_urls (
    url TEXT PRIMARY KEY,
    seen_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS chat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    ts INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS weak_points (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL UNIQUE,
    fail_count INTEGER NOT NULL DEFAULT 0,
    last_failed_at TEXT,
    source TEXT,
    origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('owner','agent','untrusted')),
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mastered_points (
    topic TEXT PRIMARY KEY,
    verified_at TEXT
  );
  CREATE TABLE IF NOT EXISTS interview_history (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    position TEXT,
    role TEXT,
    rounds INTEGER,
    avg INTEGER,
    dims TEXT,                    -- JSON {tech,expr,depth,edge,reflect}
    report TEXT                   -- 长文 markdown
  );

  -- ========== 域 2: study-plan ==========
  CREATE TABLE IF NOT EXISTS study_plan_items (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    topic TEXT NOT NULL,
    why TEXT,
    source TEXT,
    verify_question TEXT,
    done INTEGER NOT NULL DEFAULT 0,
    reviewed INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    reviewed_at TEXT,
    level TEXT,
    from_interview INTEGER NOT NULL DEFAULT 0,
    grp TEXT NOT NULL DEFAULT '',   -- 主题簇分组（LLM 提炼时标注，展示层按 grp 分组；SQL 保留字所以不用 group）
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_plan_date ON study_plan_items(date);
  CREATE INDEX IF NOT EXISTS idx_plan_topic ON study_plan_items(topic);

  -- ========== 域 3: review-cards ==========
  CREATE TABLE IF NOT EXISTS review_cards (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    source TEXT,
    -- FSRS 整对象存 JSON 列（保持 ts-fsrs 字段形状），另拆 due 用于查询
    fsrs TEXT NOT NULL DEFAULT '{}',
    fsrs_due INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cards_due ON review_cards(fsrs_due);
  CREATE TABLE IF NOT EXISTS card_reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL,
    reviewed_at INTEGER NOT NULL
  );

  -- ========== 域 4: kp-mastery ==========
  CREATE TABLE IF NOT EXISTS kp_mastery (
    topic TEXT PRIMARY KEY,
    score REAL NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_at TEXT
  );

  -- ========== 域 5: 校招岗位（job） ==========
  CREATE TABLE IF NOT EXISTS job_posts (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL,
    title TEXT NOT NULL,               -- 岗位名（前端开发工程师）
    job_type TEXT NOT NULL DEFAULT '校招',  -- 校招/实习/提前批
    direction TEXT NOT NULL DEFAULT 'frontend',  -- frontend/agent/fullstack/other
    apply_url TEXT,                    -- 投递链接
    deadline TEXT,                     -- 截止日期（YYYY-MM-DD 或空）
    bishi_date TEXT,                   -- 笔试时间（可空）
    source TEXT,                       -- 来源（牛客/官网/内推）
    status TEXT NOT NULL DEFAULT 'new',  -- new/ready/apply/ready_bishi/done
    favorite INTEGER NOT NULL DEFAULT 0, -- 收藏标记（0/1）
    summary TEXT,                      -- 岗位描述摘要
    jd_text TEXT DEFAULT '',           -- JD 详情页正文（懒抓缓存，≤4000 字符）
    applied_at INTEGER,                -- 首次投递时间戳（毫秒，未投递为空）
    found_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_direction ON job_posts(direction);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON job_posts(status);

  -- 公司档案（含中厂/未知公司：先搜集公司信息再找校招入口）
  CREATE TABLE IF NOT EXISTS company_profiles (
    id TEXT PRIMARY KEY,
    company TEXT NOT NULL UNIQUE,
    url TEXT,                    -- 校招官网/招聘页（找到才填）
    direction TEXT,              -- frontend/agent/fullstack/other/unknown
    scale TEXT,                  -- 大厂/中厂/独角兽/未知
    description TEXT,            -- 公司简介/方向
    has_career_site INTEGER NOT NULL DEFAULT 0,  -- 是否已定位官网源
    found_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- ========== 域 6: 技术资讯摘要（rss digest） ==========
  CREATE TABLE IF NOT EXISTS rss_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed TEXT,                       -- 来源 feed（站点名/URL）
    title TEXT NOT NULL,
    link TEXT NOT NULL,
    summary TEXT,                    -- RSS 原文摘要（截断）
    reason TEXT,                     -- LLM 生成的「为什么值得看」一句话理由
    published_at INTEGER,            -- 发布时间戳（毫秒）
    digest_date TEXT NOT NULL,       -- 摘要日期（YYYY-MM-DD）
    seen INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_rss_digest_date ON rss_items(digest_date);

  -- ========== 域 7: 专注监督（focus/pomodoro） ==========
  CREATE TABLE IF NOT EXISTS focus_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,                    -- 25/45（分钟）
    started_at INTEGER NOT NULL,
    ended_at INTEGER,                      -- NULL = 未结束（进行中/中断）
    completed INTEGER NOT NULL DEFAULT 0,  -- 0 中断 / 1 完成
    distracts INTEGER NOT NULL DEFAULT 0,  -- 分心次数
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_focus_started ON focus_sessions(started_at);

  -- ========== 元数据 ==========
  CREATE TABLE IF NOT EXISTS schema_meta (
    meta_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    migrated_at INTEGER NOT NULL
  );
  PRAGMA user_version = 1;
  `);
  // 记录版本
  db.prepare(
    `INSERT INTO schema_meta (meta_key, schema_version, migrated_at) VALUES ('schema', 1, ?)
     ON CONFLICT(meta_key) DO UPDATE SET schema_version = excluded.schema_version`
  ).run(Date.now());
}

// ---------- 初始化 ----------
ensureSchema();
mkdirSync(DATA_DIR, { recursive: true });

// ---------- 迁移：study_plan_items.grp（主题簇分组） ----------
// 旧库无此列 → ALTER ADD；SQLite 无 ADD COLUMN IF NOT EXISTS → try/catch 幂等
// 新库建表已含 grp 列，此处会静默跳过；已有数据 grp 保持空串（展示层归"未分类"）
try {
  db.exec("ALTER TABLE study_plan_items ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
} catch { /* 列已存在（新库或已迁移过） */ }
