// 记忆模块 v2：用户画像 + 关注点 + 学习进度 + 薄弱点 + 跨会话对话历史
// 持久化到 data/mianshi.db（SQLite，替代 JSON 文件）
import { randomUUID } from "node:crypto";
import { db } from "./db.mjs";
import { getCareerProfile, directionLabel } from "./career.mjs";

// ---------- 薄弱点表述相似判定（面试提问措辞每次不同 → 同一知识点不应分裂成多条） ----------
// 判据（对真实措辞漂移有效、排除短词噪声）：
//   1) 提取中文连续段（去标点/英文/空格）
//   2) 短者 < 4 字 → 不判（"缓存" vs "浏览器缓存"、"可信点" vs "不可信点" 这类不合并）
//   3) 共享中文 3-gram ≥ 1 → 相似（"状态机" 同时出现在双方 → 同一知识点）
//   4) 否则 2-gram 重叠率 ≥ 0.6（短者的 ≥60% 2-gram 出现在长者中）
export function isSimilarWeakTopic(a, b) {
  if (!a || !b || a === b) return false;
  const zh = (s) => String(s).replace(/[^\u4e00-\u9fff]+/g, "");
  const grams = (s, n) => {
    const out = new Set();
    for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
    return out;
  };
  const za = zh(a), zb = zh(b);
  const [short, long] = za.length <= zb.length ? [za, zb] : [zb, za];
  if (short.length < 4) return false;
  const g3s = grams(short, 3), g3l = grams(long, 3);
  for (const x of g3s) if (g3l.has(x)) return true; // 共享 3-gram → 强相似信号
  const g2s = grams(short, 2), g2l = grams(long, 2);
  let overlap = 0;
  for (const x of g2s) if (g2l.has(x)) overlap++;
  return overlap / g2s.size >= 0.6;
}

function defaults() {  // 默认求职目标跟随方向画像（转方向/开源自动跟随；画像不可用时"求职"）
  let target = "求职";
  try {
    const prof = getCareerProfile();
    target = `${directionLabel()}${prof.examNote ? "·" + prof.examNote : ""}`;
  } catch { /* ignore */ }
  return {
    profile: { name: "", target, level: "unknown" },
    interests: [],           // 关注点 [topic]
    seenUrls: [],            // 已看帖子
    chatHistory: [],         // 跨会话对话历史 [{role, content, ts}]
    weakPoints: [],          // 薄弱点 [{topic, failCount, lastFailedAt, source, origin}]
    masteredPoints: [],      // 已掌握 [{topic, verifiedAt}]
    studyProgress: {},       // { topic: {done, reviewed, times} }
    interview: null,         // 进行中的模拟面试会话
    interviewHistory: [],    // 历史面试记录 [{date, role, position, rounds, avgScore, dims, weakPoints}]
    stats: { chats: 0, questionsSolved: 0, reviewsDone: 0, interviewsDone: 0, lastActive: "" },
  };
}

// 从 DB 加载内存镜像（启动时一次性；之后 setter 增量写库）
function load() {
  const d = defaults();
  // settings 表：profile/stats/interview（JSON 列）
  const rows = db.prepare("SELECT key, value FROM settings").all();
  for (const r of rows) {
    try { d[r.key] = JSON.parse(/** @type {string} */ (r.value)); } catch { /* ignore */ }
  }
  // interests
  d.interests = db.prepare("SELECT topic FROM interests ORDER BY added_at").all().map((r) => r.topic);
  // seenUrls
  d.seenUrls = db.prepare("SELECT url FROM seen_urls ORDER BY seen_at").all().map((r) => r.url);
  // chatHistory（保留最近 40）
  d.chatHistory = db.prepare("SELECT role, content, ts FROM chat_history ORDER BY id DESC LIMIT 40").all()
    .reverse().map((r) => ({ role: r.role, content: r.content, ts: r.ts }));
  // weakPoints
  d.weakPoints = db.prepare("SELECT topic, fail_count, last_failed_at, source, origin FROM weak_points").all()
    .map((r) => ({ topic: r.topic, failCount: r.fail_count, lastFailedAt: r.last_failed_at, source: r.source, origin: r.origin }));
  // masteredPoints
  d.masteredPoints = db.prepare("SELECT topic, verified_at FROM mastered_points").all()
    .map((r) => ({ topic: r.topic, verifiedAt: r.verified_at }));
  // interviewHistory
  d.interviewHistory = db.prepare("SELECT date, position, role, rounds, avg, dims, report FROM interview_history").all()
    .map((r) => ({ date: r.date, position: r.position, role: r.role, rounds: r.rounds, avg: r.avg, dims: r.dims ? JSON.parse(/** @type {string} */ (r.dims)) : null, report: r.report }));
  return d;
}

let mem = load();

// 通用 KV 写（profile/stats/interview）
function saveSetting(key, value) {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  } catch { /* ignore */ }
}

export const memory = {
  // ---------- 基础 ----------
  get() { return mem; },

  // ---------- 关注点 ----------
  getInterests() { return mem.interests || []; },
  addInterests(topics) {
    const list = mem.interests || [];
    const added = [];
    for (const t of (topics || [])) {
      const clean = String(t).trim().slice(0, 30);
      if (clean && !list.includes(clean)) { list.push(clean); added.push(clean); }
    }
    mem.interests = list.slice(-20);
    // 增量写 DB + DB 侧同步裁剪（镜像只留 20，DB 全量保留会让重启后镜像=DB 全量，永不修剪）
    try {
      const ins = db.prepare("INSERT OR IGNORE INTO interests (topic, added_at) VALUES (?, ?)");
      for (const t of added) ins.run(t, Date.now());
      db.prepare("DELETE FROM interests WHERE topic NOT IN (SELECT topic FROM interests ORDER BY added_at DESC LIMIT 20)").run();
    } catch { /* ignore */ }
    return added;
  },

  // ---------- 已看帖子 ----------
  isSeen(url) { return (mem.seenUrls || []).includes(url); },
  markSeen(url) {
    if (!url) return;
    mem.seenUrls = [...(mem.seenUrls || []), url].slice(-500);
    // 增量写 DB + DB 侧同步裁剪（镜像只留 500，DB 全量保留会让重启后镜像=DB 全量，永不修剪）
    try {
      db.prepare("INSERT OR IGNORE INTO seen_urls (url, seen_at) VALUES (?, ?)").run(url, Date.now());
      db.prepare("DELETE FROM seen_urls WHERE url NOT IN (SELECT url FROM seen_urls ORDER BY seen_at DESC LIMIT 500)").run();
    } catch { /* ignore */ }
  },

  // ---------- 对话历史（跨会话） ----------
  getChatHistory() { return mem.chatHistory || []; },
  appendChat(role, content, sessionId = "default") {
    mem.chatHistory = [...(mem.chatHistory || []), { role, content, ts: Date.now() }].slice(-40);
    mem.stats.chats = (mem.stats.chats || 0) + 1;
    mem.stats.lastActive = new Date().toISOString();
    // 增量写 DB（按会话隔离；无 session 时归 'default'）
    try {
      db.prepare("INSERT INTO chat_history (role, content, ts, session_id) VALUES (?, ?, ?, ?)")
        .run(role, String(content), Date.now(), String(sessionId || "default").slice(0, 64));
      // 防无限堆积：DB 保留最近 200 条（面板恢复显示 + 复盘留余量），超出自动删最旧
      db.prepare("DELETE FROM chat_history WHERE id <= (SELECT MAX(id) FROM chat_history) - 200").run();
      saveSetting("stats", mem.stats);
    } catch { /* ignore */ }
  },
  /** 读取指定会话的消息（多会话；无 session 参数 = 默认会话） */
  getChatMessages(sessionId = "default", limit = 40) {
    try {
      return db.prepare(
        "SELECT role, content, ts FROM chat_history WHERE session_id=? ORDER BY id DESC LIMIT ?"
      ).all(String(sessionId || "default").slice(0, 64), limit)
        .reverse().map((r) => ({ role: r.role, content: r.content, ts: r.ts }));
    } catch { return []; }
  },
  /** 会话列表：[{id, title, count, updatedAt}]（title = 首条 user 消息前 20 字；默认会话优先） */
  listChatSessions() {
    try {
      const rows = db.prepare(`
        SELECT session_id,
               COUNT(*) count,
               MAX(ts) updated_at,
               (SELECT content FROM chat_history c2 WHERE c2.session_id = chat_history.session_id AND c2.role='user' ORDER BY c2.id LIMIT 1) first_user
        FROM chat_history GROUP BY session_id ORDER BY updated_at DESC
      `).all();
      return rows.map((r) => ({
        id: r.session_id,
        count: Number(r.count) || 0,
        updatedAt: Number(r.updated_at) || 0,
        title: String(r.first_user || "").replace(/\s+/g, " ").trim().slice(0, 20) || "新对话",
      }));
    } catch { return []; }
  },
  /** 删除会话（'default' 会重建为空） */
  deleteChatSession(sessionId) {
    try {
      db.prepare("DELETE FROM chat_history WHERE session_id=?").run(String(sessionId || "").slice(0, 64));
      return { ok: true };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // ---------- 薄弱点 ----------
  getWeakPoints() { return mem.weakPoints || []; },
  // 可信薄弱点：只返回 owner/agent 来源（untrusted 如爬虫页面提炼的伪知识点不注入 prompt）；
  // 按 failCount 降序（错得最多的最该补）——修复：此前依赖内存镜像插入序，fail 最高的可能排后面被截断
  getTrustedWeakPoints(limit = 20) {
    return (mem.weakPoints || [])
      .filter((w) => w.origin !== "untrusted")
      .sort((a, b) => (b.failCount || 0) - (a.failCount || 0) || (Number(new Date(b.lastFailedAt || 0)) - Number(new Date(a.lastFailedAt || 0))))
      .slice(0, limit);
  },
  // 过滤伪知识点：考察维度名/泛化标签/空值 → 不记录（只保留具体知识点名）
  // 修复 LOW-9：原实现 slice(0,40) 后又 reject >30 → 31~40 字合法知识点被静默丢弃
  // （上限自相矛盾）。改为统一截断到 30 字：长 topic 保留前 30 字，不再丢弃
  _cleanTopic(topic) {
    if (!topic) return null;
    const t = String(topic).trim().slice(0, 30);
    if (!t) return null;
    if (/考察维度|综合能力|表达能力|^维度|^综合|^沟通|^态度|^思维|^逻辑|面试表现|整体表现|^无$|^暂无|^none$/i.test(t)) return null;
    return t;
  },
  // 相似合并：模拟面试/复习的提问每次措辞不同（"状态机与异步并发" vs
  // "异步状态机与并发提交控制"）——精确 topic 去重会把同一知识点拆成多条刷屏、
  // fail_count 被拆散（实测同一知识点分裂成 5 条）。判据见 isSimilarWeakTopic。
  // 查 DB 全量（镜像只留 top20）。
  _findSimilarWeak(topic) {
    const g = String(topic || "");
    try {
      for (const r of db.prepare("SELECT topic FROM weak_points").all()) {
        const other = String(r.topic || "");
        if (isSimilarWeakTopic(g, other)) return other;
      }
    } catch { /* DB 不可用时不做相似合并 */ }
    return null;
  },
  // 记录薄弱点：failCount 累加，source 记来源，origin 记可信级别（owner/agent/untrusted）
  // meta 可选：{ question, answer }——原题与正确答案（有则随复习卡保存）
  addWeakPoint(topic, source, origin = "agent", meta = {}) {
    const clean = this._cleanTopic(topic);
    if (!clean) return; // 伪知识点不记录
    // 表述漂移合并：近似条目存在 → 合并到它（保留原 topic，保证引用一致，列表收敛）
    const target = this._findSimilarWeak(clean) || clean;
    const now = new Date().toISOString();
    // 先按目标主题做 DB 增量 UPSERT（不依赖裁剪后的镜像——被挤出 top20 的主题
    // 也会在 DB 累计 fail_count，下次重入不再被重置为 1）
    try {
      db.prepare(`INSERT INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at)
        VALUES (?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(topic) DO UPDATE SET
          fail_count = fail_count + 1,
          last_failed_at = excluded.last_failed_at,
          source = excluded.source,
          origin = excluded.origin,
          updated_at = excluded.updated_at`)
        .run(`wp_${Date.now().toString(36)}${randomUUID().slice(0, 8)}`, target, now, source || null, origin || "agent", Date.now());
    } catch { /* ignore */ }
    // 更新镜像 + 裁剪（保持现有行为：镜像只留 20 条）
    const list = mem.weakPoints || [];
    const found = list.find((w) => w.topic === target);
    if (found) {
      found.failCount = (found.failCount || 0) + 1;
      found.lastFailedAt = now;
      if (source) found.source = source;
      found.origin = origin; // 溯源：保留最新来源可信级别
    } else {
      list.push({ topic: target, failCount: 1, lastFailedAt: now, source, origin });
    }
    mem.weakPoints = list.sort((a, b) => (b.failCount || 0) - (a.failCount || 0)).slice(0, 20);

    // 薄弱点 → FSRS 复习卡（动态 import 打破 review.mjs ←→ memory.mjs 循环依赖；失败不影响薄弱点记录）
    // 注意：卡 topic 必须用 target（合并后的键）——复习答对时 clearWeakPoint(card.topic)
    // 精确匹配薄弱点；用新表述 clean 建卡会导致"答对复习清不掉薄弱点"的闭环断裂
    try {
      import("./review.mjs").then(({ review }) => {
        const question = String(meta?.question || "").trim().slice(0, 300) || target;
        const answer = String(meta?.answer || "").slice(0, 500);
        const dup = review.loadCards().cards.some((c) => c.topic === target && c.question === question);
        if (dup) return; // 去重：同 topic+question 已存在则跳过
        review.addCard({ topic: target, question, answer, source: "薄弱点" });
      }).catch(() => { /* 复习卡创建失败不阻塞薄弱点记录 */ });
    } catch { /* ignore */ }
  },
  // 从复盘判分结果回流：错/部分对 → 薄弱点
  applyReviewResults(results) {
    if (!results) return;
    for (const r of results) {
      if (!r.topic) continue;
      const clean = this._cleanTopic(r.topic);
      if (!clean) continue; // 伪知识点跳过
      if (r.verdict === "错") {
        this.addWeakPoint(clean, "复盘验证", "agent", { answer: r.reference });
        this.recordProgress(clean, "failed");
      } else if (r.verdict === "部分对") {
        this.addWeakPoint(clean, "复盘验证", "agent", { answer: r.reference });
        this.recordProgress(clean, "partial");
      } else {
        this.addMastered(clean);
        this.recordProgress(clean, "passed");
      }
    }
    mem.stats.reviewsDone = (mem.stats.reviewsDone || 0) + 1;
    try { saveSetting("stats", mem.stats); } catch { /* ignore */ }
  },
  clearWeakPoint(topic) {
    // 归一化后再匹配删除：与 addWeakPoint 的存储键（_cleanTopic：trim + 截断 30 + 伪知识点过滤）
    // 一致，否则调用方传入未截断/未 trim 的原始 topic 时精确匹配不到（截断键不一致历史 bug）
    const clean = this._cleanTopic(topic);
    if (clean === null) return; // 伪知识点/空：addWeakPoint 同样拒绝，镜像与 DB 中不会有对应条目
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== clean);
    // 增量写 DB
    try {
      db.prepare("DELETE FROM weak_points WHERE topic = ?").run(clean);
    } catch { /* ignore */ }
  },

  // ---------- 已掌握 ----------
  getMastered() { return mem.masteredPoints || []; },
  addMastered(topic) {
    const list = mem.masteredPoints || [];
    if (!list.find((m) => m.topic === topic)) {
      list.push({ topic, verifiedAt: new Date().toISOString() });
    }
    mem.masteredPoints = list.slice(-30);
    // 掌握后清掉对应薄弱点
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== topic);
    // 增量写 DB
    try {
      db.prepare("INSERT OR IGNORE INTO mastered_points (topic, verified_at) VALUES (?, ?)").run(topic, new Date().toISOString());
      db.prepare("DELETE FROM weak_points WHERE topic = ?").run(topic);
    } catch { /* ignore */ }
  },

  // ---------- 学习进度 ----------
  recordProgress(topic, status) {
    const p = mem.studyProgress || {};
    if (!p[topic]) p[topic] = { times: 0, done: false, reviewed: false };
    p[topic].times = (p[topic].times || 0) + 1;
    if (status === "done") p[topic].done = true;
    if (status === "reviewed") p[topic].reviewed = true;
    mem.studyProgress = p;
    // 写 DB（settings 表，整对象）
    try { saveSetting("studyProgress", p); } catch { /* ignore */ }
  },

  // ---------- 对话摘要（给 system prompt 的画像） ----------
  getProfileSummary() {
    const parts = [];
    const interests = mem.interests || [];
    const weak = mem.weakPoints || [];
    if (interests.length) parts.push(`关注点：${interests.join("、")}`);
    if (weak.length) parts.push(`薄弱点：${weak.slice(0, 5).map((w) => `${w.topic}(${w.failCount}次)`).join("、")}`);
    if (mem.profile.target) parts.push(`目标：${mem.profile.target}`);
    if (parts.length === 0) return "新用户";
    return parts.join("；");
  },

  // ---------- 模拟面试会话 ----------
  getInterview() { return mem.interview; },
  setInterview(session) { mem.interview = session; try { saveSetting("interview", session); } catch { /* ignore */ } },
  clearInterview() { mem.interview = null; try { saveSetting("interview", null); } catch { /* ignore */ } },
  saveInterviewHistory(record) {
    mem.interviewHistory = [...(mem.interviewHistory || []), record].slice(-20);
    mem.stats.interviewsDone = (mem.stats.interviewsDone || 0) + 1;
    // 增量写 DB
    try {
      db.prepare(`INSERT OR IGNORE INTO interview_history (id, date, position, role, rounds, avg, dims, report)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          `iv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, // 随机后缀防同毫秒碰撞（循环/高频保存会撞 id → OR IGNORE 丢记录）
          String(record.date || ""),
          record.position || null, record.role || null,
          record.rounds || null, record.avg ?? record.avgScore ?? null,
          record.dims ? JSON.stringify(record.dims) : null,
          (record.report || "").slice(0, 10000)
        );
      saveSetting("stats", mem.stats);
    } catch { /* ignore */ }
  },
  getInterviewHistory() { return mem.interviewHistory || []; },

  // ---------- 长期记忆（curated_memory，dreaming 提炼） ----------
  // 按重要度降序、最近更新降序返回（带来源溯源）
  getCuratedMemory(limit = 50) {
    try {
      return db.prepare(
        `SELECT topic, content, source_ref, importance, origin, created_at, updated_at
         FROM curated_memory ORDER BY importance DESC, updated_at DESC LIMIT ?`
      ).all(limit)
        .map((r) => ({
          topic: r.topic,
          content: r.content,
          sourceRef: r.source_ref,
          importance: r.importance,
          origin: r.origin,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
        }));
    } catch { return []; }
  },

  // 把长期记忆注入基础提示词（追加"长期记忆（带来源）"章节；limit 控制条数防塞爆 prompt）
  injectCuratedIntoPrompt(basePrompt, limit = 8) {
    const cur = this.getCuratedMemory(limit);
    if (!cur.length) return basePrompt;
    const lines = cur.map((m) => `- ${m.topic}（来源:${m.sourceRef || "未知"}）：${m.content || ""}`).join("\n");
    return `${basePrompt}\n\n## 长期记忆（带来源）\n${lines}`;
  },

  // 一次性整理：合并历史表述漂移的薄弱点（同一知识点分裂多条 → 归并为一条，
  // fail_count 累加到 fail_count 最高的条目，其余删除）。幂等；widget 启动可自愈。
  mergeSimilarWeakPoints() {
    let merged = 0, removed = 0;
    try {
      const rows = db.prepare("SELECT id, topic, fail_count, source, origin FROM weak_points").all();
      const clusters = []; // [{ keep: {id,topic,fail_count,source,origin}, members: [ids] }]
      for (const r of rows) {
        const c = clusters.find((cl) => isSimilarWeakTopic(cl.keep.topic, String(r.topic)));
        if (c) { c.members.push(r.id); merged++; }
        else clusters.push({ keep: r, members: [] });
      }
      for (const cl of clusters) {
        if (!cl.members.length) continue;
        // 簇内选 fail_count 最高的条目保留，其余 fail_count 累加进它后删除
        const group = [cl.keep, ...cl.members.map((id) => rows.find((r) => r.id === id))].filter(Boolean);
        const best = group.reduce((a, b) => (Number(b.fail_count) || 0) > (Number(a.fail_count) || 0) ? b : a, group[0]);
        const total = group.reduce((n, r) => n + (Number(r.fail_count) || 0), 0);
        db.prepare("UPDATE weak_points SET fail_count = ?, updated_at = ? WHERE id = ?")
          .run(total, Date.now(), best.id);
        for (const r of group) {
          if (r.id !== best.id) {
            db.prepare("DELETE FROM weak_points WHERE id = ?").run(r.id);
            removed++;
          }
        }
      }
      // 镜像同步（重新从 DB 加载薄弱点）
      try {
        mem.weakPoints = db.prepare("SELECT topic, fail_count, last_failed_at, source, origin FROM weak_points ORDER BY fail_count DESC").all()
          .map((r) => ({ topic: r.topic, failCount: Number(r.fail_count) || 0, lastFailedAt: r.last_failed_at, source: r.source, origin: r.origin }))
          .slice(0, 20);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
    return { ok: true, merged, removed };
  },
};
