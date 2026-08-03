// 一次性迁移：4 个 JSON → SQLite（单事务 + count 校验 + JSON 备份 .bak）
// 用法: node scripts/migrate-json-to-sqlite.mjs [--dry-run]
import { readFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db, withTx } from "../lib/db.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
const DRY_RUN = process.argv.includes("--dry-run");

function readJson(file, fallback) {
  const p = path.join(DATA_DIR, file);
  if (!existsSync(p)) return fallback;
  try { return JSON.parse(readFileSync(p, "utf8")); } catch (e) { console.error(`⚠️ ${file} 解析失败: ${e.message}`); return fallback; }
}
const now = Date.now();

// ---------- 收集所有数据（先读后写，事务外） ----------
const mem = readJson("agent-memory.json", {});
const plan = readJson("study-plan.json", { date: "", items: [] });
const cards = readJson("review-cards.json", { cards: [], lastReviewDate: "" });
const kp = readJson("kp-mastery.json", {});

const counts = {
  interests: mem.interests?.length || 0,
  seenUrls: new Set(mem.seenUrls || []).size,   // DB 按 url 主键去重，比唯一数
  chatHistory: mem.chatHistory?.length || 0,
  weakPoints: mem.weakPoints?.length || 0,
  mastered: mem.masteredPoints?.length || 0,
  interviewHistory: mem.interviewHistory?.length || 0,
  studyItems: plan.items?.length || 0,
  reviewCards: cards.cards?.length || 0,
  kpTopics: Object.keys(kp).length || 0,
};

console.log("待迁移数据:", JSON.stringify(counts));
if (DRY_RUN) { console.log("--dry-run，不写入"); process.exit(0); }

// ---------- 单事务导入 ----------
try {
  withTx(() => {
    // settings: profile / stats / interview（整对象 JSON）
    for (const key of ["profile", "stats", "interview"]) {
      if (mem[key] !== undefined) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
          .run(key, JSON.stringify(mem[key]), now);
      }
    }
    // interests
    const insI = db.prepare("INSERT OR IGNORE INTO interests (topic, added_at) VALUES (?, ?)");
    for (const t of mem.interests || []) insI.run(String(t), now);
    // seenUrls
    const insU = db.prepare("INSERT OR IGNORE INTO seen_urls (url, seen_at) VALUES (?, ?)");
    for (const u of mem.seenUrls || []) insU.run(String(u), now);
    // chatHistory
    const insC = db.prepare("INSERT OR IGNORE INTO chat_history (role, content, ts) VALUES (?, ?, ?)");
    for (const c of mem.chatHistory || []) insC.run(String(c.role || ""), String(c.content || ""), Number(c.ts) || now);
    // weakPoints（保留 origin，缺失默认 agent）
    const insW = db.prepare("INSERT OR IGNORE INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const w of mem.weakPoints || []) {
      insW.run(
        `wp_${now}_${Math.random().toString(36).slice(2, 8)}`,
        String(w.topic),
        Number(w.failCount) || 0,
        w.lastFailedAt || null,
        w.source || null,
        ["owner", "agent", "untrusted"].includes(w.origin) ? w.origin : "agent",
        now
      );
    }
    // masteredPoints
    const insM = db.prepare("INSERT OR IGNORE INTO mastered_points (topic, verified_at) VALUES (?, ?)");
    for (const m of mem.masteredPoints || []) insM.run(String(m.topic), m.verifiedAt || null);
    // interviewHistory
    const insH = db.prepare("INSERT OR IGNORE INTO interview_history (id, date, position, role, rounds, avg, dims, report) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const h of mem.interviewHistory || []) {
      insH.run(
        `iv_${now}_${Math.random().toString(36).slice(2, 8)}`,
        String(h.date || ""),
        h.position || null, h.role || null,
        h.rounds || null, h.avg ?? h.avgScore ?? null,
        h.dims ? JSON.stringify(h.dims) : null,
        (h.report || "").slice(0, 10000)
      );
    }
    // study_plan_items
    const insP = db.prepare(`INSERT OR IGNORE INTO study_plan_items
      (id, date, topic, why, source, verify_question, done, reviewed, done_at, reviewed_at, level, from_interview, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of plan.items || []) {
      insP.run(
        String(it.id), String(plan.date || ""), String(it.topic),
        it.why || null, it.source || null, it.verify_question || null,
        it.done ? 1 : 0, it.reviewed ? 1 : 0,
        it.doneAt || null, it.reviewedAt || null,
        it.level || null, it.fromInterview ? 1 : 0, now
      );
    }
    // review_cards（fsrs 整对象 JSON + due 拆列）
    const insR = db.prepare(`INSERT OR IGNORE INTO review_cards
      (id, topic, question, answer, source, fsrs, fsrs_due, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const c of cards.cards || []) {
      const fsrsJson = JSON.stringify(c.fsrs || {});
      const dueMs = c.fsrs?.due ? new Date(c.fsrs.due).getTime() : 0;
      insR.run(
        String(c.id), String(c.topic), String(c.question || c.topic || ""),
        String(c.answer || ""), c.source || null,
        fsrsJson, dueMs,
        c.createdAt ? new Date(c.createdAt).getTime() : now, now
      );
    }
    // kp_mastery
    const insK = db.prepare("INSERT OR IGNORE INTO kp_mastery (topic, score, attempts, last_at) VALUES (?, ?, ?, ?)");
    for (const [topic, v] of Object.entries(kp)) {
      insK.run(String(topic), Number(v.score) || 0, Number(v.attempts) || 0, v.lastAt || null);
    }
  });
} catch (e) {
  console.error("❌ 迁移失败（已回滚）:", e.message);
  process.exit(1);
}

// ---------- 校验 ----------
const verify = {
  interests: db.prepare("SELECT COUNT(*) n FROM interests").get().n,
  seenUrls: db.prepare("SELECT COUNT(*) n FROM seen_urls").get().n,
  chatHistory: db.prepare("SELECT COUNT(*) n FROM chat_history").get().n,
  weakPoints: db.prepare("SELECT COUNT(*) n FROM weak_points").get().n,
  mastered: db.prepare("SELECT COUNT(*) n FROM mastered_points").get().n,
  interviewHistory: db.prepare("SELECT COUNT(*) n FROM interview_history").get().n,
  studyItems: db.prepare("SELECT COUNT(*) n FROM study_plan_items").get().n,
  reviewCards: db.prepare("SELECT COUNT(*) n FROM review_cards").get().n,
  kpTopics: db.prepare("SELECT COUNT(*) n FROM kp_mastery").get().n,
};
let allOk = true;
for (const k of Object.keys(counts)) {
  const ok = counts[k] === verify[k];
  if (!ok) allOk = false;
  console.log(`${ok ? "✅" : "❌"} ${k}: JSON ${counts[k]} → DB ${verify[k]}`);
}
if (!allOk) {
  console.error("❌ count 校验不一致，不备份 JSON（保留数据可重跑）");
  process.exit(1);
}

// ---------- 备份 JSON ----------
if (!DRY_RUN) {
  for (const f of ["agent-memory.json", "study-plan.json", "review-cards.json", "kp-mastery.json"]) {
    const src = path.join(DATA_DIR, f);
    const bak = path.join(DATA_DIR, f + ".bak");
    if (existsSync(src)) renameSync(src, bak);
  }
  console.log("\n✅ 迁移完成！JSON 已备份为 .bak，主存储切换为 mianshi.db");
  console.log("   备份: data/agent-memory.json.bak 等 4 个");
}
