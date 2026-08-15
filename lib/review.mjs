// 间隔复习模块（FSRS 记忆调度）
// 薄弱点/答错的题 → 复习卡片 → 按遗忘曲线安排到期复习 → 复习后更新状态
import { randomUUID } from "node:crypto";
import { fsrs, Grades, createEmptyCard } from "ts-fsrs";
import { memory } from "./memory.mjs";
import { db, withTx } from "./db.mjs";
import { matchKp, recordKp } from "./knowledge.mjs";

const scheduler = fsrs();

// 安全解析 FSRS JSON：任何损坏值回退空卡（否则一条坏数据拖垮所有 review 读取）
function parseFsrs(raw) {
  if (!raw) return createEmptyCard();
  try { return JSON.parse(/** @type {string} */ (raw)); } catch { return createEmptyCard(); }
}

function loadCards() {
  const rows = db.prepare("SELECT id, topic, question, answer, source, fsrs, created_at FROM review_cards").all();
  // 复习次数：card_reviews 按卡聚合（面板展示"已复习 N 次"用 history.length）
  const counts = db.prepare("SELECT card_id, COUNT(*) n FROM card_reviews GROUP BY card_id").all();
  const countMap = {};
  for (const c of counts) countMap[c.card_id] = c.n;
  return {
    cards: rows.map((r) => {
      const n = countMap[r.id] || 0;
      return {
        id: r.id, topic: r.topic, question: r.question, answer: r.answer, source: r.source,
        fsrs: parseFsrs(r.fsrs),
        createdAt: r.created_at ? new Date(Number(r.created_at)).toISOString() : "",
        history: Array(n), // 复习次数（card_reviews 行数），面板读 history.length
      };
    }),
    lastReviewDate: db.prepare("SELECT MAX(reviewed_at) d FROM card_reviews").get()?.d || "",
  };
}
function saveCards(db2) {
  // 卡片数据由各方法增量写 DB（addCard/reviewCard 直接写 review_cards 表）
  // 兼容旧调用：空操作
  void db2;
}

export const review = {
  // 读取全部卡片（含复习次数 history）——供外部去重/统计
  loadCards() {
    return loadCards();
  },

  // 从知识点创建/更新复习卡片（答错/薄弱点时调用）——增量写 DB
  addCard({ topic, question = "", answer = "", source = "" }) {
    const data = loadCards();
    let card = data.cards.find((c) => c.topic === topic);
    if (!card) {
      card = {
        id: `c${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,
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
    // 校验 rating：仅接受整数 0-3；非法值按 Rating.Good(2) 处理（防越界/脏数据误判答对答错）
    const ratingNum = Number.isInteger(rating) && rating >= 0 && rating <= 3 ? rating : 2;
    const r = scheduler.next(card.fsrs, new Date(), Grades[ratingNum]);
    card.fsrs = r.card;
    card.history.push({ at: new Date().toISOString(), rating: ratingNum, due: r.card.due });
    // 复习答对（Good/Easy）→ 清除薄弱点
    if (ratingNum >= 2 && card.topic) memory.clearWeakPoint(card.topic);
    // 掌握度写回（增强链路，失败不影响复习主流程）：rating>=2 记答对（Easy=3 记强掌握），rating<2 记答错
    try {
      if (card.topic) {
        const kpId = matchKp(card.topic); // 只匹配 23 个预定义知识点，匹配不到跳过
        if (kpId) recordKp(kpId, { correct: ratingNum >= 2, strong: ratingNum === 3 });
      }
    } catch { /* ignore */ }
    // 增量写 DB：更新 fsrs + 记录 review（包事务，防崩溃于两步之间导致状态不一致）
    try {
      withTx(() => {
        const dueMs = new Date(r.card.due).getTime();
        db.prepare("UPDATE review_cards SET fsrs=?, fsrs_due=?, updated_at=? WHERE id=?")
          .run(JSON.stringify(card.fsrs), dueMs, Date.now(), id);
        db.prepare("INSERT INTO card_reviews (card_id, rating, reviewed_at) VALUES (?, ?, ?)")
          .run(id, ratingNum, Date.now());
      });
    } catch { /* ignore */ }
    return { ok: true, card, nextDue: r.card.due };
  },

  // 今天到期的卡片（按稳定性升序——最易忘的先复习）
  getDueCards() {
    const data = loadCards();
    const now = new Date();
    const DAY = 24 * 60 * 60 * 1000;
    return data.cards
      .filter((c) => {
        // 新卡（从未复习）给首复习缓冲：创建 1 天后才进到期队列（避免建卡即到期刷屏）
        if (c.history.length === 0) {
          const created = c.createdAt ? new Date(c.createdAt).getTime() : now.getTime();
          return created + DAY <= now.getTime();
        }
        return new Date(c.fsrs.due) <= now;
      })
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
