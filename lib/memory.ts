// 记忆模块 v2：用户画像 + 关注点 + 学习进度 + 薄弱点 + 跨会话对话历史
// 持久化到 data/mianshi.db（SQLite，替代 JSON 文件）
// 全量 TS 升级工单叶子批次 R4：原 .mjs 为 @ts-strict + 全导出 JSDoc（checkJs 最严），
// 迁 .ts 后 JSDoc 转真实类型标注；lib/memory.mjs 保留为桶（50+ 导入位零改动）

// 架构 P1-1：面试会话 idle 超时阈值（30 分钟无活动自动失效）
const INTERVIEW_IDLE_MS = 30 * 60 * 1000;

/** 薄弱点形状（内存镜像字段——驼峰；DB 行存下划线列） */
export interface WeakPoint {
  topic: string;
  failCount: number;
  /** 最近失败时间（ISO） */
  lastFailedAt?: string | null;
  /** 来源（模拟面试/复习/手写题练习/agent） */
  source?: string | null;
  /** 来源类型（agent/manual/untrusted） */
  origin?: string | null;
  question?: string;
  answer?: string;
}

/** 模拟面试会话（会话治理字段；业务字段由 interview-session 写入，宽松） */
export interface InterviewSession {
  finished?: boolean;
  updatedAt?: number;
  [key: string]: unknown;
}

/** 面试历史记录（saveInterviewHistory 输入；DB 行直通的镜像字段含 bigint——不转换保持原值） */
export interface InterviewHistoryRecord {
  date?: string | null;
  position?: string | number | bigint | null;
  role?: string | number | bigint | null;
  rounds?: string | number | bigint | null;
  avg?: number | bigint | null;
  avgScore?: number | bigint | null;
  dims?: unknown;
  report?: string | null;
}

/** 对话历史条目（跨会话，带 sessionId 供精确清理） */
export interface ChatEntry {
  role: string;
  content: string;
  ts: number;
  sessionId: string;
}

/** 已掌握条目 */
export interface MasteredPoint {
  topic: string;
  verifiedAt: string;
}

import { randomUUID } from "node:crypto";
import { db } from "./db.mjs";
import { getCareerProfile, directionLabel } from "./career.mjs";
import { similarityRule } from "./similarity.ts"; // 相似度引擎统一工单：薄弱点合并/讲解复用统一走引擎

// 薄弱点闭环补全工单任务 1①：薄弱点自动入清单开关（fail_count≥2 时）
// 测试环境默认关闭——fire-and-forget 异步入清单会泄漏到后续测试（改 DB/消费 mock 队列）；
// 接线测试用 setWeakToPlanAuto(true) 显式开启。生产（widget/desktop）默认开启。
let autoWeakToPlan = process.env.MIANSHI_TEST !== "1";
/** 开关：薄弱点反复答错自动入学习清单（默认开；测试环境默认关）。返回当前值 */
export function setWeakToPlanAuto(enabled: unknown): boolean {
  autoWeakToPlan = !!enabled;
  return autoWeakToPlan;
}

// ---------- 薄弱点表述相似判定（面试提问措辞每次不同 → 同一知识点不应分裂成多条） ----------
// 判据已收编到 lib/similarity.ts（相似度引擎统一工单）——isSimilarWeakTopic 委托 similarityRule(weak)
/**
 * 薄弱点相似判定（宽松 3-gram：措辞漂移去重——"状态机与异步并发" vs "异步状态机与并发提交控制"）
 * 相似度引擎统一工单：委托 similarityRule(weak)——词表/阈值集中，不再散落
 */
export function isSimilarWeakTopic(a: string, b: string): boolean {
  return similarityRule(a, b, "weak").similar;
}

// ---------- 讲解复用判据（与薄弱点去重不同：讲解复用要求"同一知识点的不同表述"） ----------
// 已收编到 lib/similarity.ts（strict 严格度：结构词/变体词/泛词/2-gram 0.6 集中）——
// isSimilarTopicForArchive 委托 similarityRule(strict)
/**
 * 讲解存档相似判定（比薄弱点更严——防"数组中第K个最大元素"误配"1-n数组中未出现数"）
 * 相似度引擎统一工单：委托 similarityRule(strict)——结构词/变体词/泛词/2-gram 0.6 集中
 */
export function isSimilarTopicForArchive(a: string, b: string): boolean {
  return similarityRule(a, b, "strict").similar;
}

/** 记忆镜像（defaults() 形状——与 DB 各表/设置列对应） */
interface MemoryState {
  profile: { name: string; target: string; level: string };
  interests: string[];
  seenUrls: string[];
  chatHistory: ChatEntry[];
  weakPoints: WeakPoint[];
  masteredPoints: MasteredPoint[];
  studyProgress: Record<string, { done?: boolean; reviewed?: boolean; times: number }>;
  interview: InterviewSession | null;
  interviewHistory: InterviewHistoryRecord[];
  stats: { chats: number; questionsSolved: number; reviewsDone: number; interviewsDone: number; lastActive: string };
}

function defaults(): MemoryState {  // 默认求职目标跟随方向画像（转方向/开源自动跟随；画像不可用时"求职"）
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
function load(): MemoryState {
  const d = defaults();
  // settings 表：profile/stats/interview（JSON 列）
  const rows = db.prepare("SELECT key, value FROM settings").all() as unknown as Array<{ key: string; value: unknown }>;
  for (const r of rows) {
    try { (d as unknown as Record<string, unknown>)[r.key] = JSON.parse(String(r.value)); } catch { /* ignore */ }
  }
  // interests
  d.interests = db.prepare("SELECT topic FROM interests ORDER BY added_at").all().map((r) => String(r.topic));
  // seenUrls
  d.seenUrls = db.prepare("SELECT url FROM seen_urls ORDER BY seen_at").all().map((r) => String(r.url));
  // chatHistory（保留最近 40；条目带 sessionId——删除会话时精确清理内存镜像）
  d.chatHistory = db.prepare("SELECT role, content, ts, session_id FROM chat_history ORDER BY id DESC LIMIT 40").all()
    .reverse().map((r) => ({ role: String(r.role), content: String(r.content), ts: Number(r.ts), sessionId: String(r.session_id || "default") }));
  // weakPoints
  d.weakPoints = db.prepare("SELECT topic, fail_count, last_failed_at, source, origin FROM weak_points").all()
    .map((r) => ({ topic: String(r.topic), failCount: Number(r.fail_count), lastFailedAt: String(r.last_failed_at ?? ""), source: r.source == null ? null : String(r.source), origin: r.origin == null ? null : String(r.origin) }));
  // masteredPoints
  d.masteredPoints = db.prepare("SELECT topic, verified_at FROM mastered_points").all()
    .map((r) => ({ topic: String(r.topic), verifiedAt: String(r.verified_at) }));
  // interviewHistory（DB 行直通边界显式转换：文本 String、数值 Number、dims JSON 解析——与 saveInterviewHistory 写端同口径）
  d.interviewHistory = db.prepare("SELECT date, position, role, rounds, avg, dims, report FROM interview_history").all()
    .map((r) => ({
      date: r.date == null ? null : String(r.date),
      position: r.position == null ? null : String(r.position),
      role: r.role == null ? null : String(r.role),
      rounds: r.rounds == null ? null : Number(r.rounds),
      avg: r.avg == null ? null : Number(r.avg),
      dims: r.dims ? JSON.parse(String(r.dims)) : null,
      report: r.report == null ? null : String(r.report),
    }));
  return d;
}

let mem = load();

// 通用 KV 写（profile/stats/interview）
function saveSetting(key: string, value: unknown): void {
  try {
    db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify(value), Date.now());
  } catch { /* ignore */ }
}

export const memory = {
  // ---------- 基础 ----------
  get(): MemoryState { return mem; },

  // ---------- 关注点 ----------
  getInterests(): string[] { return mem.interests || []; },
  addInterests(topics: unknown): string[] {
    const list = mem.interests || [];
    const added: string[] = [];
    for (const t of (Array.isArray(topics) ? topics : [])) {
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
  isSeen(url: unknown): boolean { return (mem.seenUrls || []).includes(String(url)); },
  markSeen(url: unknown): void {
    if (!url) return;
    mem.seenUrls = [...(mem.seenUrls || []), String(url)].slice(-500);
    // 增量写 DB + DB 侧同步裁剪（镜像只留 500，DB 全量保留会让重启后镜像=DB 全量，永不修剪）
    try {
      db.prepare("INSERT OR IGNORE INTO seen_urls (url, seen_at) VALUES (?, ?)").run(String(url), Date.now());
      db.prepare("DELETE FROM seen_urls WHERE url NOT IN (SELECT url FROM seen_urls ORDER BY seen_at DESC LIMIT 500)").run();
    } catch { /* ignore */ }
  },

  // ---------- 对话历史（跨会话） ----------
  getChatHistory(): ChatEntry[] { return mem.chatHistory || []; },
  appendChat(role: string, content: unknown, sessionId = "default"): void {
    const sid = String(sessionId || "default").slice(0, 64);
    // 内存条目带 sessionId（修复：删除会话时按此精确清理内存镜像，防已删会话复活注入 prompt）
    mem.chatHistory = [...(mem.chatHistory || []), { role, content: String(content), ts: Date.now(), sessionId: sid }].slice(-40);
    mem.stats.chats = (mem.stats.chats || 0) + 1;
    mem.stats.lastActive = new Date().toISOString();
    // 增量写 DB（按会话隔离；无 session 时归 'default'）
    try {
      db.prepare("INSERT INTO chat_history (role, content, ts, session_id) VALUES (?, ?, ?, ?)")
        .run(role, String(content), Date.now(), sid);
      // 防无限堆积：按会话各自保留最近 200 条（修复：原全局 200 条互截——
      // 高频使用的会话会把其他会话旧消息顶掉，多会话历史被静默吞）
      db.prepare("DELETE FROM chat_history WHERE session_id = ? AND id <= (SELECT MAX(id) FROM chat_history WHERE session_id = ?) - 200").run(sid, sid);
      saveSetting("stats", mem.stats);
    } catch { /* ignore */ }
  },
  /** 读取指定会话的消息（多会话；无 session 参数 = 默认会话） */
  getChatMessages(sessionId = "default", limit = 40): Array<{ role: string; content: string; ts: number }> {
    try {
      return db.prepare(
        "SELECT role, content, ts FROM chat_history WHERE session_id=? ORDER BY id DESC LIMIT ?"
      ).all(String(sessionId || "default").slice(0, 64), limit)
        .reverse().map((r) => ({ role: String(r.role), content: String(r.content), ts: Number(r.ts) }));
    } catch { return []; }
  },
  /** 会话列表：[{id, title, count, updatedAt}]（title = 首条 user 消息前 20 字；默认会话优先） */
  listChatSessions(): Array<{ id: string; count: number; updatedAt: number; title: string }> {
    try {
      const rows = db.prepare(`
        SELECT session_id,
               COUNT(*) count,
               MAX(ts) updated_at,
               (SELECT content FROM chat_history c2 WHERE c2.session_id = chat_history.session_id AND c2.role='user' ORDER BY c2.id LIMIT 1) first_user
        FROM chat_history GROUP BY session_id ORDER BY updated_at DESC
      `).all() as unknown as Array<{ session_id: unknown; count: unknown; updated_at: unknown; first_user: unknown }>;
      return rows.map((r) => ({
        id: String(r.session_id),
        count: Number(r.count) || 0,
        updatedAt: Number(r.updated_at) || 0,
        title: String(r.first_user || "").replace(/\s+/g, " ").trim().slice(0, 20) || "新对话",
      }));
    } catch { return []; }
  },
  /** 删除会话（'default' 会重建为空）——DB + 内存镜像同步清（修复：原只删 DB，
   *  mem.chatHistory 残留 → 已删会话借 agent 无 history 路径复活注入 prompt） */
  deleteChatSession(sessionId: unknown): { ok: boolean; error?: string } {
    const sid = String(sessionId || "").slice(0, 64);
    try {
      db.prepare("DELETE FROM chat_history WHERE session_id=?").run(sid);
      if (sid && mem.chatHistory?.length) {
        mem.chatHistory = mem.chatHistory.filter((m) => m.sessionId !== sid);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  },

  // ---------- 薄弱点 ----------
  getWeakPoints(): WeakPoint[] { return mem.weakPoints || []; },
  // 可信薄弱点：只返回 owner/agent 来源（untrusted 如爬虫页面提炼的伪知识点不注入 prompt）；
  // 按 failCount 降序（错得最多的最该补）——修复：此前依赖内存镜像插入序，fail 最高的可能排后面被截断
  /** 可信薄弱点（按 fail_count 降序，供面试官/复习消费） */
  getTrustedWeakPoints(limit = 20): WeakPoint[] {
    return (mem.weakPoints || [])
      .filter((w) => w.origin !== "untrusted")
      .sort((a, b) => (b.failCount || 0) - (a.failCount || 0) || (Number(new Date(b.lastFailedAt || 0)) - Number(new Date(a.lastFailedAt || 0))))
      .slice(0, limit);
  },
  // 过滤伪知识点：考察维度名/泛化标签/空值 → 不记录（只保留具体知识点名）
  // 修复 LOW-9：原实现 slice(0,40) 后又 reject >30 → 31~40 字合法知识点被静默丢弃
  // （上限自相矛盾）。改为统一截断到 30 字：长 topic 保留前 30 字，不再丢弃
  // 2026-09 再修：LLM 复盘输出"无具体技术知识点，缺乏项目描述与自我介绍"类伪知识点
  // （无实质内容）未被过滤 → 进薄弱点/复习卡/学习清单刷屏——补模式
  _cleanTopic(topic: unknown): string | null {
    if (!topic) return null;
    const t = String(topic).trim().slice(0, 30);
    if (!t) return null;
    if (/考察维度|综合能力|表达能力|^维度|^综合|^沟通|^态度|^思维|^逻辑|面试表现|整体表现|^无$|^暂无|^none$|无具体技术|缺乏项目描述|无技术知识点|无实质|无内容|无知识点|^无[^，。]{0,6}$|^题\d+【|^到期/i.test(t)) return null;
    return t;
  },
  // 相似合并：模拟面试/复习的提问每次措辞不同（"状态机与异步并发" vs
  // "异步状态机与并发提交控制"）——精确 topic 去重会把同一知识点拆成多条刷屏、
  // fail_count 被拆散（实测同一知识点分裂成 5 条）。判据见 isSimilarWeakTopic。
  // 查 DB 全量（镜像只留 top20）。
  _findSimilarWeak(topic: unknown): string | null {
    const g = String(topic || "");
    try {
      // 抽样（性能工单任务 4：全表 O(N) 扫描→ 最近 200 条——相似合并对象通常是近期重复）
      for (const r of db.prepare("SELECT topic FROM weak_points ORDER BY updated_at DESC LIMIT 200").all() as unknown as Array<{ topic: unknown }>) {
        const other = String(r.topic || "");
        if (isSimilarWeakTopic(g, other)) return other;
      }
    } catch { /* DB 不可用时不做相似合并 */ }
    return null;
  },
  // 记录薄弱点：failCount 累加，source 记来源，origin 记可信级别（owner/agent/untrusted）
  // meta 可选：{ question, answer }——原题与正确答案（有则随复习卡保存）
  /** 记录薄弱点（伪知识点过滤 + 相似合并去重） */
  addWeakPoint(topic: unknown, source: string | null | undefined, origin = "agent", meta: { question?: string; answer?: string } = {}): void {
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

    // 薄弱点闭环补全工单任务 1①：fail_count ≥ 2（反复答错）自动入学习清单（source=薄弱点，level 必会）
    // ——薄弱点从"只能积累"变"可学掉"：入清单 → 学完勾选 → 自动清除（checkItem 闭环）
    // fire-and-forget（addWeakPoint 是同步 API）；测试环境默认关闭（防异步泄漏），接线测试显式开启
    if (autoWeakToPlan) {
      try {
        const row = db.prepare("SELECT fail_count FROM weak_points WHERE topic = ?").get(target);
        const failCount = Number(row?.fail_count) || 1;
        if (failCount >= 2) {
          import("./study.mjs").then(({ addPlanItems }) => {
            addPlanItems([{
              topic: target,
              why: "薄弱点反复答错（fail_count≥2），优先补强",
              source: "薄弱点",
              level: "必会",
            }]);
          }).catch(() => { /* 入清单失败不影响薄弱点记录 */ });
        }
      } catch { /* ignore */ }
    }

    // 薄弱点 → FSRS 复习卡（动态 import 打破 review ←→ memory 循环依赖；失败不影响薄弱点记录）
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
  /** 复盘结果回流（错题 → 薄弱点，答对 → 已掌握） */
  applyReviewResults(results: Array<{ topic: string; verdict: string; reference?: string }> | null | undefined): void {
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
  /** 清除薄弱点（答对/已掌握后移除） */
  clearWeakPoint(topic: unknown): void {
    // 归一化后再匹配删除：与 addWeakPoint 的存储键（_cleanTopic：trim + 截断 30 + 伪知识点过滤）
    // 一致，否则调用方传入未截断/未 trim 的原始 topic 时精确匹配不到（截断键不一致历史 bug）
    const clean = this._cleanTopic(topic);
    if (clean === null) return; // 伪知识点/空：addWeakPoint 同样拒绝，镜像与 DB 中不会有对应条目
    const existed = (mem.weakPoints || []).some((w) => w.topic === clean);
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== clean);
    // 增量写 DB
    try {
      const r = db.prepare("DELETE FROM weak_points WHERE topic = ?").run(clean);
      // 薄弱点消灭进度可视化工单任务 1：真的删除了才累计"已消灭"计数（镜像或 DB 命中）
      if (existed || r.changes > 0) this._bumpClearedCount();
    } catch { /* ignore */ }
  },

  // 薄弱点消灭进度可视化工单任务 1：累计"已消灭薄弱点"数（settings 持久化——清除历史可感知）
  _bumpClearedCount(): void {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='weak_cleared_count'").get();
      const n = row?.value ? Number(row.value) || 0 : 0;
      db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('weak_cleared_count', ?, ?)").run(String(n + 1), Date.now());
    } catch { /* ignore */ }
  },
  /** 已消灭薄弱点总数（累计清除——用户可感知的进步） */
  getClearedWeakCount(): number {
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key='weak_cleared_count'").get();
      return row?.value ? Number(row.value) || 0 : 0;
    } catch { return 0; }
  },

  // ---------- 已掌握 ----------
  getMastered(): MasteredPoint[] { return mem.masteredPoints || []; },
  addMastered(topic: unknown): void {
    const t = String(topic);
    const list = mem.masteredPoints || [];
    if (!list.find((m) => m.topic === t)) {
      list.push({ topic: t, verifiedAt: new Date().toISOString() });
    }
    mem.masteredPoints = list.slice(-30);
    // 掌握后清掉对应薄弱点（薄弱点消灭进度可视化工单任务 1：清除计入"已消灭"）
    const hadWeak = (mem.weakPoints || []).some((w) => w.topic === t);
    mem.weakPoints = (mem.weakPoints || []).filter((w) => w.topic !== t);
    // 增量写 DB
    try {
      db.prepare("INSERT OR IGNORE INTO mastered_points (topic, verified_at) VALUES (?, ?)").run(t, new Date().toISOString());
      const r = db.prepare("DELETE FROM weak_points WHERE topic = ?").run(t);
      if (hadWeak || r.changes > 0) this._bumpClearedCount();
    } catch { /* ignore */ }
  },

  // ---------- 学习进度 ----------
  /** 记录学习进度（判题/清单/复习自动埋点） */
  recordProgress(topic: unknown, status: string): void {
    const p = mem.studyProgress || {};
    const t = String(topic);
    if (!p[t]) p[t] = { times: 0, done: false, reviewed: false };
    p[t].times = (p[t].times || 0) + 1;
    if (status === "done") p[t].done = true;
    if (status === "reviewed") p[t].reviewed = true;
    mem.studyProgress = p;
    // 写 DB（settings 表，整对象）
    try { saveSetting("studyProgress", p); } catch { /* ignore */ }
  },

  // ---------- 对话摘要（给 system prompt 的画像） ----------
  /** 画像摘要（方向/关注点/薄弱点/掌握度——供 prompt 注入） */
  getProfileSummary(): string {
    const parts: string[] = [];
    const interests = mem.interests || [];
    // 修复 B1：画像会注入 system prompt——untrusted（爬虫提炼的伪知识点）必须过滤，
    // 与 getTrustedWeakPoints 同一口径（此前直接用未过滤 weakPoints，实锤漏洞）
    const weak = this.getTrustedWeakPoints(5);
    if (interests.length) parts.push(`关注点：${interests.join("、")}`);
    if (weak.length) parts.push(`薄弱点：${weak.map((w) => `${w.topic}(${w.failCount}次)`).join("、")}`);
    if (mem.profile.target) parts.push(`目标：${mem.profile.target}`);
    if (parts.length === 0) return "新用户";
    return parts.join("；");
  },

  // ---------- 模拟面试会话 ----------
  // 架构 P1-1：会话治理——idle 超时（30 分钟无活动自动失效）+ 每次写入自动打 updatedAt
  // （并发写保护依赖 updatedAt + 调用方乐观引用校验：getInterview() !== session 即拒绝写入）
  getInterview(): InterviewSession | null { return mem.interview; },
  setInterview(session: InterviewSession | null): void {
    if (session && typeof session === "object") session.updatedAt = Date.now();
    mem.interview = session;
    try { saveSetting("interview", session); } catch { /* ignore */ }
  },
  clearInterview(): void { mem.interview = null; try { saveSetting("interview", null); } catch { /* ignore */ } },
  /** 会话是否超过 idle 阈值（30 分钟无活动；无 updatedAt 的旧会话按未超时处理，兼容存量） */
  isInterviewIdle(): boolean {
    const s = mem.interview;
    if (!s || s.finished) return false;
    if (!s.updatedAt) return false; // 旧格式会话（无时间戳）不误杀
    return Date.now() - Number(s.updatedAt) > INTERVIEW_IDLE_MS;
  },
  saveInterviewHistory(record: InterviewHistoryRecord): void {
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
  getInterviewHistory(): InterviewHistoryRecord[] { return mem.interviewHistory || []; },

  // ---------- 长期记忆（curated_memory，dreaming 提炼） ----------
  // 按重要度降序、最近更新降序返回（带来源溯源）
  // 架构 P1-7：先过滤 untrusted（SQL WHERE）再 LIMIT——此前先 LIMIT 后 filter，
  // 前 N 条含 untrusted 时可信记忆不足 N 条且不补足（注入 prompt 的记忆条数缩水）
  getCuratedMemory(limit = 50): Array<{ topic: string; content: string; sourceRef: string; importance: number; origin: string; createdAt: number; updatedAt: number }> {
    try {
      const rows = db.prepare(
        `SELECT topic, content, source_ref, importance, origin, created_at, updated_at
         FROM curated_memory WHERE origin != 'untrusted' ORDER BY importance DESC, updated_at DESC LIMIT ?`
      ).all(limit) as unknown as Array<{ topic: unknown; content: unknown; source_ref: unknown; importance: unknown; origin: unknown; created_at: unknown; updated_at: unknown }>;
      return rows.map((r) => ({
        topic: String(r.topic ?? ""),
        content: String(r.content ?? ""),
        sourceRef: String(r.source_ref ?? ""),
        importance: Number(r.importance),
        origin: String(r.origin ?? ""),
        createdAt: Number(r.created_at),
        updatedAt: Number(r.updated_at),
      }));
    } catch { return []; }
  },

  // 把长期记忆注入基础提示词（追加"长期记忆（带来源）"章节；limit 控制条数防塞爆 prompt）
  injectCuratedIntoPrompt(basePrompt: string, limit = 8): string {
    // 修复 B1：注入 prompt 前过滤 untrusted（双保险——即使写入端漏标，注入端也不放行）
    const cur = this.getCuratedMemory(limit).filter((m) => m.origin !== "untrusted");
    if (!cur.length) return basePrompt;
    const lines = cur.map((m) => `- ${m.topic}（来源:${m.sourceRef || "未知"}）：${m.content || ""}`).join("\n");
    return `${basePrompt}\n\n## 长期记忆（带来源）\n${lines}`;
  },

  // 编排能力缺口工单 T4：相关记忆检索注入——按用户当前问题动态检索 curated/薄弱点/近期对话
  // （替代固定 top-8 排序注入：query 相关条目优先；规则层打分零 LLM 零成本）
  /** 相关记忆检索（按分数降序，≤k 条） */
  async retrieveRelevant(query: unknown, k = 8): Promise<Array<{ text: string; source: string; score: number }>> {
    const q = String(query || "").trim();
    if (!q) return [];
    try {
      const { similarity } = await import("./similarity.ts");
      const candidates: Array<{ text: string; source: string; score: number }> = [];
      // curated（已过滤 untrusted——P1-7 先 filter 后 LIMIT）
      for (const m of this.getCuratedMemory(50)) {
        const s = await similarity(q, `${m.topic} ${String(m.content || "").slice(0, 200)}`, "weak", { useLlm: false });
        if (s.score >= 0.3) candidates.push({ text: `${m.topic}：${String(m.content || "").slice(0, 150)}`, source: `curated:${m.topic}`, score: s.score });
      }
      // 薄弱点（可信来源——untrusted 伪知识点不注入）
      for (const w of (mem.weakPoints || [])) {
        if (w.origin === "untrusted") continue;
        const s = await similarity(q, String(w.topic || ""), "weak", { useLlm: false });
        if (s.score >= 0.3) candidates.push({ text: `薄弱点：${w.topic}（答错 ${w.failCount || 0} 次）`, source: `weak:${w.topic}`, score: s.score });
      }
      // 近期对话（最近 20 条用户消息——跨会话延续）
      for (const c of (mem.chatHistory || []).slice(-20)) {
        if (c.role !== "user") continue;
        const s = await similarity(q, String(c.content || "").slice(0, 200), "weak", { useLlm: false });
        if (s.score >= 0.3) candidates.push({ text: `近期对话：${String(c.content || "").slice(0, 120)}`, source: "chat", score: s.score });
      }
      return candidates
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.min(k, 8));
    } catch { return []; }
  },

  // 一次性整理：合并历史表述漂移的薄弱点（同一知识点分裂多条 → 归并为一条，
  // fail_count 累加到 fail_count 最高的条目，其余删除）。幂等；widget 启动可自愈。
  // 薄弱点闭环补全工单任务 3②：先删伪知识点（题目占位符"题1【…】"/测试残留"到期新卡"/
  // 泛化标签——_cleanTopic 拒绝的存量脏数据），再相似合并（防伪知识点误并入真实知识点）。
  /** 相似薄弱点归并 + 伪知识点清理（表述漂移整理——幂等；低频任务，数据量通常 <200 行） */
  mergeSimilarWeakPoints(): { ok: boolean; merged: number; removed: number } {
    let merged = 0, removed = 0;
    try {
      const rows = db.prepare("SELECT id, topic, fail_count, source, origin FROM weak_points").all() as unknown as Array<{ id: unknown; topic: unknown; fail_count: unknown; source: unknown; origin: unknown }>;
      // ① 伪知识点先删（_cleanTopic 拒绝的存量脏数据——addWeakPoint 已拦新数据，这里清历史）
      const cleanRows: Array<{ id: string; topic: string; fail_count: number; source: string | null; origin: string | null }> = [];
      for (const r of rows) {
        const clean = this._cleanTopic(r.topic);
        if (!clean) {
          try { db.prepare("DELETE FROM weak_points WHERE id = ?").run(String(r.id)); } catch { /* ignore */ }
          removed++;
          continue;
        }
        cleanRows.push({ id: String(r.id), topic: clean, fail_count: Number(r.fail_count) || 0, source: r.source == null ? null : String(r.source), origin: r.origin == null ? null : String(r.origin) });
      }
      // ② 相似表述归并（簇内选 fail_count 最高的条目保留，其余 fail_count 累加进它后删除）
      const clusters: Array<{ keep: (typeof cleanRows)[number]; members: string[] }> = []; // [{ keep: {id,topic,fail_count,source,origin}, members: [ids] }]
      for (const r of cleanRows) {
        const c = clusters.find((cl) => isSimilarWeakTopic(String(cl.keep.topic), String(r.topic)));
        if (c) { c.members.push(r.id); merged++; }
        else clusters.push({ keep: r, members: [] });
      }
      for (const cl of clusters) {
        if (!cl.members.length) continue;
        const group = [cl.keep, ...cl.members.map((id) => cleanRows.find((r) => r.id === id))].filter((x): x is (typeof cleanRows)[number] => Boolean(x));
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
          .map((r) => ({ topic: String(r.topic), failCount: Number(r.fail_count) || 0, lastFailedAt: String(r.last_failed_at ?? ""), source: r.source == null ? null : String(r.source), origin: r.origin == null ? null : String(r.origin) }))
          .slice(0, 20);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
    return { ok: true, merged, removed };
  },
};
