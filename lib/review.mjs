// 间隔复习模块（FSRS 记忆调度）
// 薄弱点/答错的题 → 复习卡片 → 按遗忘曲线安排到期复习 → 复习后更新状态
import { fsrs, Rating, createEmptyCard } from "ts-fsrs";
import { memory } from "./memory.mjs";
import { db } from "./db.mjs";

const scheduler = fsrs();

function loadCards() {
  const rows = db.prepare("SELECT id, topic, question, answer, source, fsrs FROM review_cards").all();
  return {
    cards: rows.map((r) => ({
      id: r.id, topic: r.topic, question: r.question, answer: r.answer, source: r.source,
      fsrs: r.fsrs ? JSON.parse(r.fsrs) : createEmptyCard(),
      createdAt: "", history: [], // history 存 card_reviews 表（见 getHistory）
    })),
    lastReviewDate: db.prepare("SELECT MAX(reviewed_at) d FROM card_reviews").get()?.d || "",
  };
}
function saveCards(db2) {
  // 卡片数据由各方法增量写 DB（addCard/reviewCard 直接写 review_cards 表）
  // 兼容旧调用：空操作
  void db2;
}

export const review = {
  // 从知识点创建/更新复习卡片（答错/薄弱点时调用）——增量写 DB
  addCard({ topic, question = "", answer = "", source = "" }) {
    const data = loadCards();
    let card = data.cards.find((c) => c.topic === topic);
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
      // 写 DB
      try {
        db.prepare(`INSERT OR IGNORE INTO review_cards (id, topic, question, answer, source, fsrs, fsrs_due, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(card.id, topic, question, card.answer, source || null, JSON.stringify(card.fsrs), 0, Date.now(), Date.now());
      } catch { /* ignore */ }
    } else {
      card.question = question || card.question;
      card.answer = answer.slice(0, 500) || card.answer;
      // 更新 DB（不覆盖 fsrs/进度）
      try {
        db.prepare("UPDATE review_cards SET question=?, answer=?, updated_at=? WHERE id=?").run(card.question, card.answer, Date.now(), card.id);
      } catch { /* ignore */ }
    }
    return card;
  },

  // 复习一张卡片：rating 0-3 映射 FSRS (Again/Hard/Good/Easy)
  reviewCard(id, rating) {
    const data = loadCards();
    const card = data.cards.find((c) => c.id === id);
    if (!card) return { ok: false, error: "卡片不存在" };
    const r = scheduler.next(card.fsrs, new Date(), [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy][rating] || Rating.Good);
    card.fsrs = r.card;
    card.history.push({ at: new Date().toISOString(), rating, due: r.card.due });
    // 复习答对（Good/Easy）→ 清除薄弱点
    if (rating >= 2 && card.topic) memory.clearWeakPoint(card.topic);
    // 增量写 DB：更新 fsrs + 记录 review
    try {
      const dueMs = new Date(r.card.due).getTime();
      db.prepare("UPDATE review_cards SET fsrs=?, fsrs_due=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(card.fsrs), dueMs, Date.now(), id);
      db.prepare("INSERT INTO card_reviews (card_id, rating, reviewed_at) VALUES (?, ?, ?)")
        .run(id, rating, Date.now());
    } catch { /* ignore */ }
    return { ok: true, card, nextDue: r.card.due };
  },

  // 今天到期的卡片（按稳定性升序——最易忘的先复习）
  getDueCards() {
    const data = loadCards();
    const now = new Date();
    return data.cards
      .filter((c) => new Date(c.fsrs.due) <= now)
      .sort((a, b) => a.fsrs.stability - b.fsrs.stability);
  },

  // 所有卡片统计
  getStats() {
    const data = loadCards();
    const due = this.getDueCards();
    return {
      total: data.cards.length,
      due: due.length,
      mastered: data.cards.filter((c) => c.fsrs.stability >= 21).length, // 21天+稳定性≈已掌握
      learning: data.cards.filter((c) => c.fsrs.state !== 0 && c.fsrs.stability < 21).length,
    };
  },

  // 每日快速复习会话（桌宠主动提示用）
  getDailySession(limit = 8) {
    return this.getDueCards().slice(0, limit);
  },
};
