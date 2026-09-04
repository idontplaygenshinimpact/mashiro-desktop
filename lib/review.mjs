// 间隔复习模块（FSRS 记忆调度）
// 薄弱点/答错的题 → 复习卡片 → 按遗忘曲线安排到期复习 → 复习后更新状态
import { localDateKey } from "./date-utils.mjs";
import { randomUUID } from "node:crypto";
import { fsrs, Grades, createEmptyCard } from "ts-fsrs";
import { memory } from "./memory.mjs";
import { db, withTx } from "./db.mjs";
import { matchKp, recordKp, getAllPoints } from "./knowledge.mjs";
import { recordLearningEvent, buildFeedbackTip } from "./learning-plan.mjs";
import { kwHit } from "./match-utils.mjs";
import { EXTRA_GROUP_RULES } from "./study-groups.mjs";

const scheduler = fsrs();

// ---------- 算法题检测（算法题复习 = 手写模式 + 多维自评；概念题保持现状） ----------
// 复用 study-groups 的"算法与手写"兜底词表（同一检测口径，防两个词表漂移）
const ALGO_KWS = (EXTRA_GROUP_RULES.find((r) => r.g === "算法与手写") || { kws: [] }).kws;
// 概念词排除：命中算法词但标题是概念比较/原理讲解 → 概念题（B树/B+树二叉树区别、React 原理等不是手写题）
const CONCEPT_HINTS = ["区别", "对比", "原理", "是什么", "如何工作", "优缺点", "关系", "过程"];

/** 检测 topic 是否为算法题（标题/问题命中算法关键词且非概念讲解 → type: 'algo'） */
export function detectAlgoTopic(topic) {
  const t = String(topic || "");
  if (!t) return false;
  if (CONCEPT_HINTS.some((h) => t.includes(h))) return false; // 概念比较/原理讲解 → 概念题
  return ALGO_KWS.some((k) => kwHit(t, String(k)));
}

// 记忆强度估算：FSRS-6 幂律遗忘曲线 R(t)=(1+19/81·t/S)^(-0.5)
// 直接用 ts-fsrs 的 forgetting_curve（scheduler 绑定版，decay 参数与调度器同源同参）
// 未复习（state=0）或稳定性为 0 → null（前端显示"首次复习"）
function calcMemPct(fsrsState) {
  if (!fsrsState || fsrsState.state === 0 || !fsrsState.stability || fsrsState.stability <= 0) return null;
  const t = Math.max(0, Number(fsrsState.elapsed_days) || 0);
  return Math.round(scheduler.forgetting_curve(t, fsrsState.stability) * 100);
}

// 复习阶段（艾宾浩斯节奏：第几次复习）
function calcStage(reps) {
  if (!reps) return { key: "first", label: "🆕 首次复习" };
  if (reps === 1) return { key: "r1", label: "第 1 次复习" };
  if (reps === 2) return { key: "r2", label: "第 2 次复习" };
  return { key: "r3", label: `第 ${reps} 次复习` };
}

// 安全解析 FSRS JSON：任何损坏值回退空卡（否则一条坏数据拖垮所有 review 读取）
function parseFsrs(raw) {
  if (!raw) return createEmptyCard();
  try { return JSON.parse(/** @type {string} */ (raw)); } catch { return createEmptyCard(); }
}

function loadCards() {
  const rows = db.prepare("SELECT id, topic, question, answer, source, type, fsrs, created_at FROM review_cards").all();
  // 回填/纠偏：每张卡按 topic 重检测（type 是派生的——检测规则升级后旧标记一并纠正，防误标记残留）
  for (const r of rows) {
    const want = detectAlgoTopic(r.topic) ? "algo" : "concept";
    if ((r.type || "concept") !== want) {
      try {
        db.prepare("UPDATE review_cards SET type=? WHERE id=?").run(want, String(r.id));
        r.type = want;
      } catch { /* ignore */ }
    }
  }
  // 复习次数：card_reviews 按卡聚合（面板展示"已复习 N 次"用 history.length）
  const counts = db.prepare("SELECT card_id, COUNT(*) n FROM card_reviews GROUP BY card_id").all();
  const countMap = {};
  for (const c of counts) countMap[c.card_id] = c.n;
  return {
    cards: rows.map((r) => {
      const n = countMap[r.id] || 0;
      const fsrsState = parseFsrs(r.fsrs);
      return {
        id: r.id, topic: r.topic, question: r.question, answer: r.answer, source: r.source,
        type: (r.type || "concept") === "algo" ? "algo" : "concept",
        fsrs: fsrsState,
        // 记忆方法可视化：记忆强度 % + 复习阶段（艾宾浩斯节奏）
        memPct: calcMemPct(fsrsState),
        stage: calcStage(n),
        createdAt: r.created_at ? new Date(Number(r.created_at)).toISOString() : "",
        history: Array(n), // 复习次数（card_reviews 行数），面板读 history.length
      };
    }),
    lastReviewDate: db.prepare("SELECT MAX(reviewed_at) d FROM card_reviews").get()?.d || "",
  };
}

export const review = {
  // 读取全部卡片（含复习次数 history）——供外部去重/统计
  loadCards() {
    return loadCards();
  },

  // 删除复习卡（勾选取消/清单条目移除时清理；card_reviews 由外键 CASCADE 级联删除）
  deleteCard(id) {
    if (!id) return { ok: false, error: "id required" };
    try {
      const r = db.prepare("DELETE FROM review_cards WHERE id=?").run(String(id));
      return { ok: r.changes > 0 };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // 从知识点创建/更新复习卡片（答错/薄弱点时调用）——增量写 DB
  addCard({ topic, question = "", answer = "", source = "" }) {    const data = loadCards();
    let card = data.cards.find((c) => c.topic === topic);
    if (!card) {
      card = {
        id: `c${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,
        topic,
        question,
        answer: answer.slice(0, 500),
        source,
        type: detectAlgoTopic(topic) ? "algo" : "concept", // 算法题标记（手写模式 + 多维自评）
        // FSRS 状态
        fsrs: createEmptyCard(),
        // 与 loadCards 输出对齐（新卡：记忆强度 0 / 首次复习阶段；DB 只存核心字段）
        memPct: 0,
        stage: { key: "first", label: "🆕 首次复习" },
        createdAt: new Date().toISOString(),
        history: [],
      };
      // 写 DB（修复 S6：此前 catch 静默吞错仍 return card——调用方以为建卡成功，重启即消失；
      // 对齐同文件复习写库的 withTx 透传标准——失败必须可见：console.warn + 返回失败信号）
      try {
        db.prepare(`INSERT OR IGNORE INTO review_cards (id, topic, question, answer, source, type, fsrs, fsrs_due, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(card.id, topic, question, card.answer, source || null, card.type, JSON.stringify(card.fsrs), 0, Date.now(), Date.now());
      } catch (e) {
        console.warn(`[review] addCard 写库失败（topic=${topic}）: ${String(e?.message || e).slice(0, 120)}`);
        return { ok: false, error: "复习卡写库失败", topic };
      }
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
    if (ratingNum >= 2 && card.topic) memory.clearWeakPoint(String(card.topic));
    // 复习答错（Again/Hard）→ 回流薄弱点（failCount+1，下次清单/面试优先覆盖）
    if (ratingNum < 2 && card.topic) {
      try {
        memory.addWeakPoint(String(card.topic), "复习答错", "agent", {
          question: String(card.question || card.topic),
          answer: String(card.answer || ""),
        });
      } catch { /* 回流失败不影响复习主流程 */ }
    }
    // 掌握度写回（增强链路，失败不影响复习主流程）：rating>=2 记答对（Easy=3 记强掌握），rating<2 记答错
    try {
      if (card.topic) {
        const kpId = matchKp(card.topic);
        // 只写回知识树内的点——matchKp 对未命中主题会兜底返回动态主题，直接写会让
        // kp_mastery 表被不可见行撑大（getMastery 只映射树内点）且每次复习全表重写
        if (kpId && getAllPoints().some((p) => p.id === kpId)) recordKp(kpId, { correct: ratingNum >= 2, strong: ratingNum === 3 });
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
    } catch (e) {
      // 写库失败必须透传（不能静默降级为成功——否则 UI 推进但数据未持久化，进度回退且无信号）
      return { ok: false, error: `复习记录写入失败: ${String(e?.message || e).slice(0, 120)}` };
    }
    // 学习计划事件流埋点（C7 血缘闭环：复习动作进事件流 → 计划进度/趋势/即时反馈）
    // result 归一：Again=0 → fail、Hard=1 → partial、Good/Easy → pass；quality 归一 0-1
    let tip = null;
    try {
      const result = ratingNum >= 2 ? "pass" : (ratingNum === 1 ? "partial" : "fail");
      const quality = ratingNum / 3;
      recordLearningEvent({ topic: String(card.topic || ""), kind: "review", result, quality });
      tip = buildFeedbackTip({ topic: String(card.topic || ""), kind: "review", result, quality });
    } catch { /* 埋点失败不影响复习主流程 */ }
    return { ok: true, card, nextDue: r.card.due, tip };
  },

  // 今天到期的卡片
  // 排序：按"到期时间"升序（最久没复习的先——到期越早说明拖得越久，越该先复习）；
  // memPct 相同/接近时用遗忘概率微调。修复：此前按 memPct 排序，唯一复习过的卡（memPct 有值）
  // 恒排新卡（memPct=null）之前 → 推荐永远取同一张卡，复习完也不轮换
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
      .sort((a, b) => {
        // 到期时间（复习过的 = fsrs.due；新卡 = created + 1 天）
        const dueA = a.history.length === 0 ? (a.createdAt ? new Date(a.createdAt).getTime() + DAY : 0) : new Date(a.fsrs.due).getTime();
        const dueB = b.history.length === 0 ? (b.createdAt ? new Date(b.createdAt).getTime() + DAY : 0) : new Date(b.fsrs.due).getTime();
        if (dueA !== dueB) return dueA - dueB;
        // 同时到期（如同一批建卡）→ 遗忘概率低的先（memPct 小 = 更危险）
        const pa = a.memPct === null || a.memPct === undefined ? Infinity : a.memPct;
        const pb = b.memPct === null || b.memPct === undefined ? Infinity : b.memPct;
        return pa - pb;
      });
  },

  // 所有卡片统计
  getStats() {
    const data = loadCards();
    const due = this.getDueCards();
    // 今日已完成复习次数（card_reviews 表：今天有评分记录的**卡**数——修复：
    // 此前 COUNT(*) 按行数统计，同一张卡复习多次被重复计数，与"今日复习了 N 张卡"语义不符）
    let todayDone = 0;
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      todayDone = Number(db.prepare("SELECT COUNT(DISTINCT card_id) n FROM card_reviews WHERE reviewed_at >= ?").get(dayStart.getTime()).n || 0);
    } catch { /* ignore */ }
    return {
      total: data.cards.length,
      due: due.length,
      mastered: data.cards.filter((c) => c.fsrs.stability >= 21).length, // 21天+稳定性≈已掌握
      learning: data.cards.filter((c) => c.fsrs.state !== 0 && c.fsrs.stability < 21).length,
      todayDone,
    };
  },

  // 复习趋势：近 7 天每日复习卡数 + 连续复习天数（streak）
  getReviewTrend() {
    const byDay = {};
    try {
      for (const r of db.prepare("SELECT reviewed_at FROM card_reviews").all()) {
        const d = localDateKey(Number(r.reviewed_at));
        byDay[d] = (byDay[d] || 0) + 1;
      }
    } catch { /* ignore */ }
    const out = [];
    for (let i = 6; i >= 0; i--) {
      const d = localDateKey(Date.now() - i * 86400000);
      out.push({ date: d, count: byDay[d] || 0 });
    }
    // 连续复习天数：今天没复习不打断（从昨天起算），中断即停
    let streak = 0;
    for (let i = 0; i < 365; i++) {
      const d = localDateKey(Date.now() - i * 86400000);
      if (byDay[d]) streak++;
      else if (i > 0) break;
    }
    return { trend: out, streak };
  },

  // 每日快速复习会话（桌宠主动提示用）
  getDailySession(limit = 8) {
    return this.getDueCards().slice(0, limit);
  },

  // 错题本：答错（rating<2）>=2 次的卡片，按错次数降序（错得最多的最该重学）
  getWrongCards(limit = 8) {
    const rows = db.prepare(
      `SELECT r.card_id, c.topic, c.question, COUNT(*) wrong_count, MAX(r.reviewed_at) last_wrong_at
       FROM card_reviews r JOIN review_cards c ON c.id = r.card_id
       WHERE r.rating < 2 GROUP BY r.card_id HAVING wrong_count >= 2
       ORDER BY wrong_count DESC, last_wrong_at DESC LIMIT ?`
    ).all(limit);
    return rows.map((r) => ({
      id: r.card_id,
      topic: r.topic,
      question: r.question,
      wrongCount: r.wrong_count,
      lastWrongAt: r.last_wrong_at ? new Date(Number(r.last_wrong_at)).toISOString() : "",
    }));
  },

  // 今日复习过的主题（去重，供「复习完 → 面试检验」）
  getTodayReviewedTopics() {
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const rows = db.prepare(
        `SELECT DISTINCT c.topic, c.id FROM card_reviews r JOIN review_cards c ON c.id = r.card_id
         WHERE r.reviewed_at >= ? ORDER BY r.reviewed_at DESC LIMIT 12`
      ).all(dayStart.getTime());
      return rows.map((r) => ({ topic: r.topic, id: r.id }));
    } catch { /* ignore */ }
    return [];
  },
};
