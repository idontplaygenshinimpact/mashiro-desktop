// 记忆模块 v2：用户画像 + 关注点 + 学习进度 + 薄弱点 + 跨会话对话历史
// 持久化到 data/mianshi.db（SQLite，替代 JSON 文件）
import { db } from "./db.mjs";

function defaults() {
  return {
    profile: { name: "", target: "前端秋招", level: "unknown" },
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

// save() 保留为空操作（各 setter 已增量写库；兼容旧调用）
function save() { /* 持久化由各 setter 直接写 DB */ }

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
    // 增量写 DB
    try {
      const ins = db.prepare("INSERT OR IGNORE INTO interests (topic, added_at) VALUES (?, ?)");
      for (const t of added) ins.run(t, Date.now());
    } catch { /* ignore */ }
    return added;
  },

  // ---------- 已看帖子 ----------
  isSeen(url) { return (mem.seenUrls || []).includes(url); },
  markSeen(url) {
    if (!url) return;
    mem.seenUrls = [...(mem.seenUrls || []), url].slice(-500);
    // 增量写 DB
    try {
      db.prepare("INSERT OR IGNORE INTO seen_urls (url, seen_at) VALUES (?, ?)").run(url, Date.now());
    } catch { /* ignore */ }
  },

  // ---------- 对话历史（跨会话） ----------
  getChatHistory() { return mem.chatHistory || []; },
  appendChat(role, content) {
    mem.chatHistory = [...(mem.chatHistory || []), { role, content, ts: Date.now() }].slice(-40);
    mem.stats.chats = (mem.stats.chats || 0) + 1;
    mem.stats.lastActive = new Date().toISOString();
    // 增量写 DB
    try {
      db.prepare("INSERT INTO chat_history (role, content, ts) VALUES (?, ?, ?)").run(role, String(content), Date.now());
      saveSetting("stats", mem.stats);
    } catch { /* ignore */ }
  },

  // ---------- 薄弱点 ----------
  getWeakPoints() { return mem.weakPoints || []; },
  // 可信薄弱点：只返回 owner/agent 来源（untrusted 如爬虫页面提炼的伪知识点不注入 prompt）
  getTrustedWeakPoints(limit = 20) {
    return (mem.weakPoints || [])
      .filter((w) => w.origin !== "untrusted")
      .slice(0, limit);
  },
  // 过滤伪知识点：考察维度名/泛化标签/空值 → 不记录（只保留具体知识点名）
  _cleanTopic(topic) {
    if (!topic) return null;
    const t = String(topic).trim().slice(0, 40);
    if (!t || t.length > 30) return null;
    if (/考察维度|综合能力|表达能力|^维度|^综合|^沟通|^态度|^思维|^逻辑|面试表现|整体表现|^无$|^暂无|^none$/i.test(t)) return null;
    return t;
  },
  // 记录薄弱点：failCount 累加，source 记来源，origin 记可信级别（owner/agent/untrusted）
  // meta 可选：{ question, answer }——原题与正确答案（有则随复习卡保存）
  addWeakPoint(topic, source, origin = "agent", meta = {}) {
    const clean = this._cleanTopic(topic);
    if (!clean) return; // 伪知识点不记录
    const list = mem.weakPoints || [];
    const found = list.find((w) => w.topic === clean);
    if (found) {
      found.failCount = (found.failCount || 0) + 1;
      found.lastFailedAt = new Date().toISOString();
      if (source) found.source = source;
      found.origin = origin; // 溯源：保留最新来源可信级别
    } else {
      list.push({ topic: clean, failCount: 1, lastFailedAt: new Date().toISOString(), source, origin });
    }
    mem.weakPoints = list.sort((a, b) => (b.failCount || 0) - (a.failCount || 0)).slice(0, 20);
    // 增量写 DB（UPSERT：同 topic 累加 failCount）
    try {
      const row = mem.weakPoints.find((w) => w.topic === clean);
      if (row) {
        db.prepare(`INSERT INTO weak_points (id, topic, fail_count, last_failed_at, source, origin, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(topic) DO UPDATE SET fail_count=excluded.fail_count, last_failed_at=excluded.last_failed_at, source=excluded.source, origin=excluded.origin, updated_at=excluded.updated_at`)
          .run(`wp_${Date.now().toString(36)}`, row.topic, row.failCount, row.lastFailedAt, row.source || null, row.origin || "agent", Date.now());
      }
    } catch { /* ignore */ }

    // 薄弱点 → FSRS 复习卡（动态 import 打破 review.mjs ←→ memory.mjs 循环依赖；失败不影响薄弱点记录）
    try {
      import("./review.mjs").then(({ review }) => {
        const question = String(meta?.question || "").trim().slice(0, 300) || clean;
        const answer = String(meta?.answer || "").slice(0, 500);
        const dup = review.loadCards().cards.some((c) => c.topic === clean && c.question === question);
        if (dup) return; // 去重：同 topic+question 已存在则跳过
        review.addCard({ topic: clean, question, answer, source: "薄弱点" });
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
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== topic);
    // 增量写 DB
    try {
      db.prepare("DELETE FROM weak_points WHERE topic = ?").run(topic);
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
          `iv_${Date.now().toString(36)}`,
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
};
