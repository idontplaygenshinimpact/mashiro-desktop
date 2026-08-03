// agent memory 数据库层（node:sqlite 内置，替代 JSON 文件存储）
// 设计参考 OpenClaw memory-core：规范化小表 + origin 溯源列 + WAL + user_version
// 数据域：memory(agent-memory) / study(study-plan) / review(review-cards) / kp(kp-mastery)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "mianshi.db");

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
