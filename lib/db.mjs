// agent memory 数据库层（node:sqlite 内置，替代 JSON 文件存储）
// 设计参考 OpenClaw memory-core：规范化小表 + origin 溯源列 + WAL + user_version
// 数据域：memory(agent-memory) / study(study-plan) / review(review-cards) / kp(kp-mastery)
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { applyPendingRestore } from "./backup.mjs"; // 纯 fs，无 db 依赖（防循环）

// 打包版：主进程注入 MIANSHI_DATA_DIR=<userData>/data（asar 只读，数据必须落到可写目录）
const DATA_DIR = process.env.MIANSHI_DATA_DIR || path.join(import.meta.dirname, "..", "data");
// 测试隔离：MIANSHI_DB_PATH 指向临时库（生产不设置则用默认路径）
const DB_FILE = process.env.MIANSHI_DB_PATH || path.join(DATA_DIR, "mianshi.db");

// 打开库前先确保目录存在（fresh clone / 自定义 MIANSHI_DB_PATH 时 data/ 或目标目录可能缺失，
// 否则 new DatabaseSync 在 import 时抛错 → 整个 app 崩溃）
mkdirSync(DATA_DIR, { recursive: true });
mkdirSync(path.dirname(DB_FILE), { recursive: true });

// 数据恢复钩子：面板"恢复备份"标记了 restore-pending.db → 打开库前自动替换主库
// （替换前自动把当前库快照为 pre-restore 备份；失败不阻断启动，原库保留）
try { applyPendingRestore(); } catch { /* 恢复失败不阻断启动 */ }

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
    ts INTEGER NOT NULL,
    session_id TEXT NOT NULL DEFAULT 'default'
  );
  -- 学习事件流（长期学习计划引擎的唯一事实源）：任何学习动作 → 一条通用事件
  CREATE TABLE IF NOT EXISTS learning_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT,                -- 归属计划（scope 关键词匹配；未归属 NULL）
    topic TEXT NOT NULL,
    kind TEXT NOT NULL,          -- challenge_done / review_done / plan_item_done / manual
    result TEXT,                 -- pass / fail / partial
    quality REAL,                -- 0~1（判题正确率 / 复习得分 / 自评）
    duration_ms INTEGER,
    ts INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_learning_events_plan_ts ON learning_events (plan_id, ts);
  CREATE INDEX IF NOT EXISTS idx_learning_events_topic ON learning_events (topic);
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
  -- type：'concept'（概念题，默认）/ 'algo'（算法题——手写模式 + 多维自评）
  CREATE TABLE IF NOT EXISTS review_cards (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL DEFAULT '',
    source TEXT,
    type TEXT NOT NULL DEFAULT 'concept',
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

  -- ========== 域 3.5: quiz（复习选择题题库） ==========
  -- 生成策略：每卡首次复习前懒生成一批 6 题（一次 LLM 调用），每次复习随机抽 3 + 选项洗牌；
  -- 答错重学可再生成新批（batch 递增）；生成失败/未生成 → 优雅降级为纯文本卡
  CREATE TABLE IF NOT EXISTS quiz_questions (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES review_cards(id) ON DELETE CASCADE,
    batch INTEGER NOT NULL DEFAULT 1,   -- 题批号（换批时 +1）
    question TEXT NOT NULL,
    options TEXT NOT NULL,              -- JSON 数组（原序，展示时洗牌）
    answer INTEGER NOT NULL,            -- 正确项索引（原序）
    explain TEXT NOT NULL DEFAULT '',   -- 一句解析
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quiz_card ON quiz_questions(card_id, batch);
  -- 选择题作答记录（每次复习抽题后的结果；用于正确率统计 + 错题联动）
  CREATE TABLE IF NOT EXISTS quiz_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL,
    question_id TEXT NOT NULL,
    correct INTEGER NOT NULL,           -- 0/1
    answered_at INTEGER NOT NULL
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
    digest_date TEXT NOT NULL       -- 摘要日期（YYYY-MM-DD）
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

  -- ========== 域 8: 面试邀约日程（mail → LLM 识别 → 提前提醒） ==========
  CREATE TABLE IF NOT EXISTS schedule_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    role TEXT,
    interview_at INTEGER,              -- 面试/笔试时间戳（毫秒）
    form TEXT,                         -- 线上/线下/电话
    location TEXT,
    link TEXT,
    email_id TEXT,                     -- 来源邮件 id（去重用）
    last_notified_at INTEGER,          -- 上次提醒时间戳（毫秒，防重复轰炸）
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_email_id ON schedule_events(email_id);
  CREATE INDEX IF NOT EXISTS idx_schedule_interview_at ON schedule_events(interview_at);

  -- ========== 域 9: curated-memory（长期记忆，dreaming 提炼，带来源溯源） ==========
  CREATE TABLE IF NOT EXISTS curated_memory (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    content TEXT,
    source_ref TEXT,
    importance INTEGER NOT NULL DEFAULT 3,
    origin TEXT NOT NULL DEFAULT 'agent',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- UNIQUE 索引：让 INSERT OR REPLACE 按 topic 去重（同名主题覆盖更新，而非重复堆叠）
  CREATE UNIQUE INDEX IF NOT EXISTS idx_curated_memory_topic ON curated_memory(topic);

  -- ========== 域 10: scheduled-jobs（持久化定时任务，OpenClaw Automations 风格） ==========
  CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    job_type TEXT NOT NULL,
    schedule_spec TEXT NOT NULL,       -- "interval:N" | "daily:HHmm" | "* * * * *"（cron-lite）
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}', -- JSON（seed 标记 / disabled_reason 等）
    last_run_at INTEGER,               -- 上次运行时间戳（毫秒），NULL = 未运行
    next_run_at INTEGER,               -- 下次运行时间戳（毫秒），NULL = 已禁用/不排程
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_enabled ON scheduled_jobs(enabled);
  CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next_run ON scheduled_jobs(next_run_at);

  -- ========== 域 11: 手写/算法题库（ai-career 导入，本地判题闭环） ==========
  CREATE TABLE IF NOT EXISTS challenges (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,          -- handwrite / algorithm
    difficulty INTEGER NOT NULL,     -- 1-3
    frequency INTEGER NOT NULL,      -- 1-3（面试出现频率）
    time_limit INTEGER NOT NULL,     -- 建议时限（分钟）
    description TEXT,
    skeleton TEXT,                   -- 代码骨架（提取导出名用）
    test_code TEXT,                  -- 判题测试代码（__test__/__assert__ 沙箱格式）
    source TEXT NOT NULL DEFAULT 'ai-career',
    done INTEGER NOT NULL DEFAULT 0,
    done_at INTEGER,
    wrong_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_challenges_cat ON challenges(category);

  -- ========== 元数据 ==========
  CREATE TABLE IF NOT EXISTS schema_meta (
    meta_key TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL,
    migrated_at INTEGER NOT NULL
  );
  `);
  // 架构 P0-2：user_version 是唯一版本游标——全新库（0）建表后置 1；
  // 老库（历史写死的 1）保持不动，由 runMigrations 按版本补列（见下）
  if (schemaVersion() === 0) {
    db.exec("PRAGMA user_version = 1");
  }
}

// ---------- 版本化迁移框架（架构 P0-2 修复：user_version 写死 + 补列散落 + 静默吞） ----------
// 原则：
//   - user_version 是唯一版本游标（不再写死）；每个迁移成功才推进版本
//   - 迁移函数幂等（列存在性检查——SQLite 无 ADD COLUMN IF NOT EXISTS）
//   - 失败可见：console.error + 不推进版本（下次启动重试）——不静默吞
const colNames = (table) => {
  try { return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name); } catch { return []; }
};

// 迁移列表（version 递增；v1 = ensureSchema 全量建表——新库直接建全列，迁移幂等跳过）
// 注意：非 ensureSchema 建的表（knowledge_items/业务表）在 db import 时可能不存在——colNames 空 = 表不存在 → 跳过
// （表由所属模块建（含全列）；老库缺列时属模块 import 后用 ensureColumn 兜底补）
const MIGRATIONS = [
  {
    version: 2,
    name: "核心补列：chat_history.session_id / review_cards.type+priority / study_plan_items.grp",
    up() {
      if (!colNames("chat_history").includes("session_id")) {
        db.exec("ALTER TABLE chat_history ADD COLUMN session_id TEXT NOT NULL DEFAULT 'default'");
      }
      db.exec("CREATE INDEX IF NOT EXISTS idx_chat_history_session ON chat_history (session_id, id)");
      const rc = colNames("review_cards");
      if (!rc.includes("type")) db.exec("ALTER TABLE review_cards ADD COLUMN type TEXT NOT NULL DEFAULT 'concept'");
      if (!rc.includes("priority")) db.exec("ALTER TABLE review_cards ADD COLUMN priority TEXT NOT NULL DEFAULT '拓展'");
      if (!colNames("study_plan_items").includes("grp")) db.exec("ALTER TABLE study_plan_items ADD COLUMN grp TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    version: 3,
    name: "knowledge_items 溯源列（confidence/evidence/last_verified_at——表存在才补）",
    up() {
      const ki = colNames("knowledge_items");
      if (ki.length) {
        if (!ki.includes("confidence")) db.exec("ALTER TABLE knowledge_items ADD COLUMN confidence REAL DEFAULT 0.5");
        if (!ki.includes("evidence")) db.exec("ALTER TABLE knowledge_items ADD COLUMN evidence TEXT DEFAULT ''");
        if (!ki.includes("last_verified_at")) db.exec("ALTER TABLE knowledge_items ADD COLUMN last_verified_at INTEGER");
      }
    },
  },
  {
    version: 4,
    name: "rss_items.seen 死列清理 + schedule_events.email_id 索引降级（表存在才执行）",
    up() {
      if (colNames("rss_items").length) {
        try { db.exec("ALTER TABLE rss_items DROP COLUMN seen"); } catch { /* 列不存在或 SQLite 版本不支持 */ }
      }
      if (colNames("schedule_events").length) {
        db.exec("DROP INDEX IF EXISTS idx_schedule_email_id");
        db.exec("CREATE INDEX IF NOT EXISTS idx_schedule_email_id ON schedule_events(email_id)");
      }
    },
  },
];

/** 当前 schema 版本（PRAGMA user_version） */
export function schemaVersion() {
  try { return Number(db.prepare("PRAGMA user_version").get().user_version) || 0; } catch { return 0; }
}

/** 执行版本化迁移：逐条跑 version > 当前的迁移，成功才推进；失败 console.error + 不推进（下次重试） */
export function runMigrations() {
  let current = schemaVersion();
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    try {
      m.up();
      db.exec(`PRAGMA user_version = ${m.version}`);
      current = m.version;
      console.log(`[db] schema 迁移到 v${m.version}: ${m.name.slice(0, 60)}…`);
    } catch (e) {
      // 失败可见（不静默吞）：版本不推进，下次启动重试；抛出让调用方决策（widget/测试）
      console.error(`[db] schema 迁移 v${m.version} 失败: ${String(e?.message || e).slice(0, 200)}——版本未推进，下次启动重试`);
      throw e;
    }
  }
  // 版本账本（schema_meta——历史遗留表，保持同步）
  try {
    db.prepare(
      `INSERT INTO schema_meta (meta_key, schema_version, migrated_at) VALUES ('schema', ?, ?)
       ON CONFLICT(meta_key) DO UPDATE SET schema_version = excluded.schema_version`
    ).run(current, Date.now());
  } catch { /* ignore */ }
  return current;
}

/**
 * 统一幂等补列（架构 P0-2：收编散落 try/catch 补列——focus/jobs/oj/zhenti 等处）
 * @param {string} table 表名
 * @param {string} column 列名
 * @param {string} ddl 列定义（如 "TEXT NOT NULL DEFAULT ''"）
 * @returns {boolean} 是否实际补列
 */
export function ensureColumn(table, column, ddl) {
  if (!colNames(table).includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    return true;
  }
  return false;
}

// ---------- 初始化 ----------
ensureSchema();
// 架构 P0-2：版本化迁移（成功才推进 user_version；失败 console.error + 抛出让调用方可见）
try {
  runMigrations();
} catch (e) {
  console.error(`[db] schema 迁移未完成（v${schemaVersion()}）——部分功能可能异常: ${String(e?.message || e).slice(0, 150)}`);
}

// ---------- WAL checkpoint ----------
// 退出时把 -wal 合并回主库（否则 mianshi.db-wal 长期堆积比主库大）；同步调用，安全 try/catch
export function checkpoint() {
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* ignore */ }
}
process.on("exit", () => checkpoint());

// ---------- 迁移：study_plan_items.grp / knowledge_items 溯源列 / rss_items / schedule_events ----------
// 架构 P0-2：已收编进上方 MIGRATIONS（v2/v3/v4）——版本化 + 失败可见，不再散落裸 try/catch
