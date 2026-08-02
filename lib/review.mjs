// 间隔复习模块（FSRS 记忆调度）
// 薄弱点/答错的题 → 复习卡片 → 按遗忘曲线安排到期复习 → 复习后更新状态
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fsrs, Rating, createEmptyCard } from "ts-fsrs";
import { memory } from "./memory.mjs";
import { writeJsonAtomic, readJsonSafe } from "./atomic-json.mjs";

const DATA_DIR = path.join(import.meta.dirname, "..", "data");
const CARDS_FILE = path.join(DATA_DIR, "review-cards.json");

const scheduler = fsrs();

function loadCards() {
  return readJsonSafe(CARDS_FILE, { cards: [], lastReviewDate: "" });
}
function saveCards(db) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeJsonAtomic(CARDS_FILE, db);
  } catch { /* ignore */ }
}

export const review = {
  // 从知识点创建/更新复习卡片（答错/薄弱点时调用）
  addCard({ topic, question = "", answer = "", source = "" }) {
    const db = loadCards();
    let card = db.cards.find((c) => c.topic === topic);
    if (!card) {
      card = {
        id: `c${Date.now().toString(36)}`,
        topic,
        question,
        answer: answer.slice(0, 500),
        source,
        // FSRS 状态
        fsrs: createEmptyCard(),
        createdAt: new Date().toISOString(),
        history: [],
      };
      db.cards.push(card);
    } else {
      card.question = question || card.question;
      card.answer = answer.slice(0, 500) || card.answer;
    }
    saveCards(db);
    return card;
  },

  // 复习一张卡片：rating 0-3 映射 FSRS (Again/Hard/Good/Easy)
  reviewCard(id, rating) {
    const db = loadCards();
    const card = db.cards.find((c) => c.id === id);
    if (!card) return { ok: false, error: "卡片不存在" };
    const r = scheduler.next(card.fsrs, new Date(), [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy][rating] || Rating.Good);
    card.fsrs = r.card;
    card.history.push({ at: new Date().toISOString(), rating, due: r.card.due });
    // 复习答对（Good/Easy）→ 清除薄弱点
    if (rating >= 2 && card.topic) memory.clearWeakPoint(card.topic);
    db.lastReviewDate = new Date().toISOString().slice(0, 10);
    saveCards(db);
    return { ok: true, card, nextDue: r.card.due };
  },

  // 今天到期的卡片（按稳定性升序——最易忘的先复习）
  getDueCards() {
    const db = loadCards();
    const now = new Date();
    return db.cards
      .filter((c) => new Date(c.fsrs.due) <= now)
      .sort((a, b) => a.fsrs.stability - b.fsrs.stability);
  },

  // 所有卡片统计
  getStats() {
    const db = loadCards();
    const due = this.getDueCards();
    return {
      total: db.cards.length,
      due: due.length,
      mastered: db.cards.filter((c) => c.fsrs.stability >= 21).length, // 21天+稳定性≈已掌握
      learning: db.cards.filter((c) => c.fsrs.state !== 0 && c.fsrs.stability < 21).length,
    };
  },

  // 每日快速复习会话（桌宠主动提示用）
  getDailySession(limit = 8) {
    return this.getDueCards().slice(0, limit);
  },
};
