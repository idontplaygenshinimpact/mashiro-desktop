// 间隔复习模块（FSRS 记忆调度）
// 薄弱点/答错的题 → 复习卡片 → 按遗忘曲线安排到期复习 → 复习后更新状态
// 强化复习工单：清单全覆盖补卡（多角度题）+ 优先级调度 + 错题重练
import { localDateKey } from "./date-utils.ts";
import { randomUUID } from "node:crypto";
import { fsrs, Grades, createEmptyCard, type Card } from "ts-fsrs";
import { memory } from "./memory.mjs";
import { isSimilarTopicForArchive } from "./memory.mjs"; // 复习卡相似合并判据（2-gram 门槛——比 isSimilarWeakTopic 严，防误并）
import { db, withTx } from "./db.mjs";
import { matchKp, recordKp, getAllPoints } from "./knowledge.ts";
import { llmChat, getReplyText, extractJson } from "./llm.mjs";
import { recordLearningEvent, buildFeedbackTip } from "./learning-plan.mjs";
import { kwHit } from "./match-utils.ts";
import { EXTRA_GROUP_RULES } from "./study-groups.ts";

const scheduler = fsrs();

// ---------- 算法题检测（算法题复习 = 手写模式 + 多维自评；概念题保持现状） ----------
// 复用 study-groups 的"算法与手写"兜底词表（同一检测口径，防两个词表漂移）
const ALGO_KWS = (EXTRA_GROUP_RULES.find((r) => r.g === "算法与手写") || { kws: [] }).kws;
// 概念词排除：命中算法词但标题是概念比较/原理讲解 → 概念题（B树/B+树二叉树区别、React 原理等不是手写题）
const CONCEPT_HINTS = ["区别", "对比", "原理", "是什么", "如何工作", "优缺点", "关系", "过程"];

/** 复习阶段（艾宾浩斯节奏：第几次复习） */
interface ReviewStage {
  key: string;
  label: string;
}

/** 复习历史条目（reviewCard 追加；loadCards 只给长度——面板读 history.length） */
interface ReviewHistoryEntry {
  at: string;
  rating: number;
  due: Date;
}

/** 复习卡（loadCards 输出形状——含记忆强度/复习阶段等派生字段） */
export interface ReviewCard {
  id: string;
  topic: string;
  question: string;
  answer: string;
  source: string;
  type: "algo" | "concept";
  priority: string;
  fsrs: Card;
  memPct: number | null;
  stage: ReviewStage;
  createdAt: string;
  history: ReviewHistoryEntry[];
}

/** 检测 topic 是否为算法题（标题/问题命中算法关键词且非概念讲解 → type: 'algo'） */
export function detectAlgoTopic(topic: unknown): boolean {
  const t = String(topic || "");
  if (!t) return false;
  if (CONCEPT_HINTS.some((h) => t.includes(h))) return false; // 概念比较/原理讲解 → 概念题
  return ALGO_KWS.some((k) => kwHit(t, String(k)));
}

// 记忆强度估算：FSRS-6 幂律遗忘曲线 R(t)=(1+19/81·t/S)^(-0.5)
// 直接用 ts-fsrs 的 forgetting_curve（scheduler 绑定版，decay 参数与调度器同源同参）
// 未复习（state=0）或稳定性为 0 → null（前端显示"首次复习"）
function calcMemPct(fsrsState: Card | null): number | null {
  if (!fsrsState || fsrsState.state === 0 || !fsrsState.stability || fsrsState.stability <= 0) return null;
  const t = Math.max(0, Number(fsrsState.elapsed_days) || 0);
  return Math.round(scheduler.forgetting_curve(t, fsrsState.stability) * 100);
}

// 复习阶段（艾宾浩斯节奏：第几次复习）
function calcStage(reps: number): ReviewStage {
  if (!reps) return { key: "first", label: "🆕 首次复习" };
  if (reps === 1) return { key: "r1", label: "第 1 次复习" };
  if (reps === 2) return { key: "r2", label: "第 2 次复习" };
  return { key: "r3", label: `第 ${reps} 次复习` };
}

// 安全解析 FSRS JSON：任何损坏值回退空卡（否则一条坏数据拖垮所有 review 读取）
function parseFsrs(raw: unknown): Card {
  if (!raw) return createEmptyCard();
  try { return JSON.parse(String(raw)) as Card; } catch { return createEmptyCard(); }
}

// ---------- 强化复习工单任务 1：清单全覆盖补卡 + 多角度题 ----------
// 多角度题：LLM 提炼 3 个角度（原理/边界/场景）——question 从"请简述"升级为多角度
interface AngleItem {
  topic: string;
  verify_question?: string | null;
}

async function generateMultiAngle(batch: AngleItem[]): Promise<Array<{ topic: string; question: string }>> {
  const list = batch.map((b, i) => `${i}.【${b.topic}】${b.verify_question || ""}`).join("\n");
  const prompt = `以下是学习清单条目，请为每个条目提炼 3 个复习角度（原理/边界/场景各一问），用于复习卡主动回忆。

对每个条目输出：{"i":序号,"question":"原理：...；边界：...；场景：..."}

只输出 JSON 数组。`;
  try {
    const data = await llmChat(
      [
        { role: "system", content: "你是复习卡生成助手。只输出合法 JSON。" },
        // 修复：prompt 必须拼接条目列表（此前漏拼 list——LLM 不知道要提炼什么，
        // 真实调用全 fallback 成"请简述"占位卡；mock 测试不校验 prompt 内容所以没抓到）
        { role: "user", content: `${prompt}\n\n${list}` },
      ],
      { maxTokens: 2000, temperature: 0.3, role: "review" }
    );
    const parsed = extractJson(getReplyText(data)) as Array<{ i?: unknown; question?: unknown }> | null;
    const arr = Array.isArray(parsed) ? parsed : [];
    return batch.map((b, i) => {
      const r = arr.find((x) => Number(x?.i) === i);
      return { topic: b.topic, question: String(r?.question || `请简述：${b.topic}`).slice(0, 300) };
    });
  } catch {
    return batch.map((b) => ({ topic: b.topic, question: `请简述：${b.topic}` }));
  }
}

/** 清单条目全覆盖：无卡条目自动补卡（多角度 question + 优先级从 level）——幂等（补完不再补）
 * 存量升级（复习卡强化激活工单任务 2①）：已有卡但仍是旧形态——
 *   ① 优先级从清单 level 回填（必会→必会/进阶→进阶/拓展→拓展；清单外卡不动）
 *   ② 占位 question（"请简述…"/空）→ 多角度重生成（真实问题卡不覆盖，保留面试原题）
 * 幂等：升级完（priority 匹配 + question 非占位）再跑不再动、不再调 LLM */
/** 重入锁：addPlanItems 的 fire-and-forget 自动补卡可能与显式调用（widget 启动补卡/测试/scheduler）
 * 并发进入——双跑 = 双倍 LLM + 交错写（先写好 question 再被占位覆盖）；锁内只跑一轮，后到者跳过。
 * 同时消除 review.test 激活③ 的 mock 队列竞态（fire-and-forget 与显式调用竞争同一预设响应）。 */
let coverageRunning = false;
export async function ensurePlanCoverage(): Promise<{ added: number; upgraded?: number; error?: string; skipped?: string }> {
  if (coverageRunning) return { added: 0, upgraded: 0, skipped: "busy" };
  coverageRunning = true;
  try {
    const { getPlan } = await import("./study.mjs");
    const items = getPlan().items || [];
    const cards = loadCards().cards;
    const cardTopics = new Set(cards.map((c) => c.topic));
    const levelByTopic = new Map(items.map((i: { topic: string; level?: string | null }) => [i.topic, i.level]));
    const priOf = (level: string | null | undefined) => (level === "必会" ? "必会" : level === "进阶" ? "进阶" : "拓展");
    // ① 补缺口：清单无卡条目 → 多角度补卡（幂等）
    const missing = items.filter((i: { topic: string }) => !cardTopics.has(i.topic));
    let added = 0;
    for (let i = 0; i < missing.length; i += 8) {
      const batch = missing.slice(i, i + 8);
      const questions = await generateMultiAngle(batch);
      for (const q of questions) {
        const item = batch.find((b) => b.topic === q.topic);
        const r = review.addCard({
          topic: q.topic,
          question: q.question,
          answer: String(item?.verify_question || "").slice(0, 500),
          source: "学习清单",
          priority: priOf(item?.level),
        });
        if (r && "ok" in r && r.ok === false) continue;
        added++;
      }
    }
    // ② 存量升级（幂等）：优先级回填（无 LLM）+ 占位 question 多角度重生成
    let upgraded = 0;
    const stale = cards.filter((c) => {
      // SQL 结果类型在边界处收口（全量 TS 升级工单已踩坑④：node:sqlite 行值是 SQLOutputValue）
      const want = levelByTopic.get(String(c.topic));
      const priBad = want && c.priority !== priOf(want);
      // 占位 question 判定：请简述/请完整回答（verify_question 默认模板）——修复：此前只匹配
      // ^请简述，漏了"请完整回答并讲清原理"（64 张占位卡没升级——面试实录/薄弱点来源）
      const qBad = !c.question || /^请简述|^请完整回答/.test(String(c.question));
      return priBad || qBad;
    });
    for (const c of stale) {
      const want = levelByTopic.get(String(c.topic));
      if (want && c.priority !== priOf(want)) {
        db.prepare("UPDATE review_cards SET priority=?, updated_at=? WHERE id=?").run(priOf(want), Date.now(), c.id);
        upgraded++;
      }
    }
    const qStale = stale.filter((c) => !c.question || /^请简述|^请完整回答/.test(String(c.question)));
    for (let i = 0; i < qStale.length; i += 8) {
      const batch = qStale.slice(i, i + 8).map((c) => ({ topic: c.topic, verify_question: c.answer || "" }));
      const questions = await generateMultiAngle(batch);
      for (const q of questions) {
        db.prepare("UPDATE review_cards SET question=?, updated_at=? WHERE topic=?").run(q.question, Date.now(), q.topic);
        upgraded++;
      }
    }
    return { added, upgraded };
  } catch (e) {
    return { added: 0, error: String(e instanceof Error ? e.message : e).slice(0, 100) };
  } finally {
    coverageRunning = false;
  }
}

/** 复习卡 DB 行（边界映射用） */
interface ReviewRow {
  id: unknown;
  topic: unknown;
  question: unknown;
  answer: unknown;
  source: unknown;
  type: unknown;
  priority: unknown;
  fsrs: unknown;
  created_at: unknown;
}

function loadCards(): { cards: ReviewCard[]; lastReviewDate: string } {
  const rows = db.prepare("SELECT id, topic, question, answer, source, type, priority, fsrs, created_at FROM review_cards").all() as unknown as ReviewRow[];
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
  const counts = db.prepare("SELECT card_id, COUNT(*) n FROM card_reviews GROUP BY card_id").all() as unknown as Array<{ card_id: unknown; n: unknown }>;
  const countMap: Record<string, number> = {};
  for (const c of counts) countMap[String(c.card_id)] = Number(c.n);
  return {
    cards: rows.map((r) => {
      const n = countMap[String(r.id)] || 0;
      const fsrsState = parseFsrs(r.fsrs);
      return {
        id: String(r.id),
        topic: String(r.topic),
        question: String(r.question ?? ""),
        answer: String(r.answer ?? ""),
        source: String(r.source ?? ""),
        type: (r.type || "concept") === "algo" ? "algo" as const : "concept" as const,
        priority: ["必会", "进阶", "拓展"].includes(String(r.priority)) ? String(r.priority) : "拓展",
        fsrs: fsrsState,
        // 记忆方法可视化：记忆强度 % + 复习阶段（艾宾浩斯节奏）
        memPct: calcMemPct(fsrsState),
        stage: calcStage(n),
        createdAt: r.created_at ? new Date(Number(r.created_at)).toISOString() : "",
        history: new Array<ReviewHistoryEntry>(n), // 复习次数（card_reviews 行数），面板读 history.length
      } satisfies ReviewCard;
    }),
    lastReviewDate: String(db.prepare("SELECT MAX(reviewed_at) d FROM card_reviews").get()?.d || ""),
  };
}

export const review = {
  // 读取全部卡片（含复习次数 history）——供外部去重/统计
  loadCards() {
    return loadCards();
  },

  // 删除复习卡（勾选取消/清单条目移除时清理；card_reviews 由外键 CASCADE 级联删除）
  deleteCard(id: unknown): { ok: boolean; error?: string } {
    if (!id) return { ok: false, error: "id required" };
    try {
      const r = db.prepare("DELETE FROM review_cards WHERE id=?").run(String(id));
      return { ok: r.changes > 0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  // 存量漂移卡合并（工单任务 1：状态机 12 张漂移卡归一化）——幂等
  // 同簇（isSimilarTopicForArchive）保留一张：优先级最高 + 创建最早；question/answer 取更完整；
  // 其余删除（漂移卡是重复建卡，fsrs 进度保留在保留卡上）。返回 {merged}
  mergeSimilarCards(): { merged: number } {
    const data = loadCards();
    const cards = data.cards;
    let merged = 0;
    const keep: ReviewCard[] = []; // 保留卡（按遍历序，簇内第一张为基准）
    for (const c of cards) {
      const dup = keep.find((k) => isSimilarTopicForArchive(c.topic, k.topic));
      if (dup) {
        try {
          // question/answer 取更完整的（漂移卡可能带不同追问/答案）
          if (c.question.length > dup.question.length) {
            db.prepare("UPDATE review_cards SET question=?, updated_at=? WHERE id=?").run(c.question, Date.now(), dup.id);
          }
          if (c.answer.length > dup.answer.length) {
            db.prepare("UPDATE review_cards SET answer=?, updated_at=? WHERE id=?").run(c.answer, Date.now(), dup.id);
          }
          // 手动级联删 card_reviews（SQLite 外键默认关闭——DELETE 有复习记录的卡会 FOREIGN KEY constraint failed）
          try { db.prepare("DELETE FROM card_reviews WHERE card_id=?").run(c.id); } catch { /* ignore */ }
          db.prepare("DELETE FROM review_cards WHERE id=?").run(c.id);
          merged++;
        } catch { /* ignore */ }
        continue;
      }
      keep.push(c);
    }
    return { merged };
  },

  // 从知识点创建/更新复习卡片（答错/薄弱点时调用）——增量写 DB
  // priority：'必会'（手写/高频）> '进阶' > '拓展'（默认）——调度时优先高优先级（强化复习工单任务 1③）
  // 去重归一化（工单任务 1）：先精确匹配，无则相似合并（isSimilarTopicForArchive 2-gram 门槛）——
  // 防漂移卡分裂（"状态机与异步并发/异步状态机与并发提交控制/状态机状态定义与重复提交拦截机制"同一知识点多卡）
  // 判据不用 isSimilarWeakTopic（3-gram 太宽松：共享"状态机与"会把"状态机与SSE数据流联动"和"状态机与接口联动"误并）
  addCard({ topic, question = "", answer = "", source = "", priority = "拓展" }: { topic: string; question?: string; answer?: string; source?: string; priority?: string }): ReviewCard | { ok: false; error: string; topic: string } {
    const data = loadCards();
    let card = data.cards.find((c) => c.topic === topic);
    if (!card) card = data.cards.find((c) => isSimilarTopicForArchive(topic, c.topic));
    if (!card) {
      card = {
        id: `c${Date.now().toString(36)}${randomUUID().slice(0, 8)}`,
        topic,
        question,
        answer: answer.slice(0, 500),
        source,
        priority: ["必会", "进阶", "拓展"].includes(priority) ? priority : "拓展",
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
        db.prepare(`INSERT OR IGNORE INTO review_cards (id, topic, question, answer, source, type, priority, fsrs, fsrs_due, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(card.id, topic, question, card.answer, source || null, card.type, card.priority, JSON.stringify(card.fsrs), 0, Date.now(), Date.now());
      } catch (e) {
        console.warn(`[review] addCard 写库失败（topic=${topic}）: ${String(e instanceof Error ? e.message : e).slice(0, 120)}`);
        return { ok: false, error: "复习卡写库失败", topic };
      }
    } else {
      if (card.topic === topic) {
        // 精确匹配：后建覆盖（现有行为——同 topic 更新为最新）
        card.question = question || card.question;
        card.answer = answer.slice(0, 500) || card.answer;
      } else {
        // 相似合并：取更完整（防薄弱点短 question 覆盖手写题库详细 question）
        if (question.length > card.question.length) card.question = question;
        if (answer.slice(0, 500).length > card.answer.length) card.answer = answer.slice(0, 500);
      }
      // 更新 DB（不覆盖 fsrs/进度；source 保留原卡——先建的来源更具体，后建合并不覆盖）
      try {
        db.prepare("UPDATE review_cards SET question=?, answer=?, updated_at=? WHERE id=?").run(card.question, card.answer, Date.now(), card.id);
      } catch { /* ignore */ }
    }
    return card;
  },

  // 复习一张卡片：rating 0-3 映射 FSRS (Again/Hard/Good/Easy)
  reviewCard(id: unknown, rating: unknown): { ok: true; card: ReviewCard; nextDue: Date; tip: string | null; clearedWeak: string | null; isFirst: boolean } | { ok: false; error: string } {
    const data = loadCards();
    const card = data.cards.find((c) => c.id === id);
    if (!card) return { ok: false, error: "卡片不存在" };
    // 校验 rating：仅接受整数 0-3；非法值拒绝（架构 P1-8——此前默认 Rating.Good(2)=答对，
    // 脏数据/API 误用会误清薄弱点/误记掌握度——拒绝比"猜一个答案"安全）
    const ratingNum = typeof rating === "number" && Number.isInteger(rating) && rating >= 0 && rating <= 3 ? rating : null;
    if (ratingNum === null) {
      return { ok: false, error: `非法评分 ${String(rating)}（仅接受 0=Again / 1=Hard / 2=Good / 3=Easy 整数）` };
    }
    // 复习首刷不计 fail 工单任务 1：FSRS state 0（新卡首刷，还没学）——答错不累计 fail/不进薄弱点/不进错题本
    // （只记"已复习"——FSRS 调度正常走；首刷答错是"没学过"不是"学不会"）
    // 注意：必须在 scheduler.next 更新 fsrs 之前判定（评分后 state 已变）
    const isFirstReview = Number(card.fsrs?.state) === 0;
    const r = scheduler.next(card.fsrs, new Date(), Grades[ratingNum]);
    card.fsrs = r.card;
    card.history.push({ at: new Date().toISOString(), rating: ratingNum, due: r.card.due });
    // 复习答对（Good/Easy）→ 清除薄弱点（薄弱点消灭进度可视化工单任务 2：响应带 clearedWeak——前端 toast 正反馈）
    let clearedWeak: string | null = null;
    if (ratingNum >= 2 && card.topic) {
      const hadWeak = memory.getWeakPoints().some((w: { topic?: unknown }) => w.topic === card.topic);
      memory.clearWeakPoint(card.topic);
      if (hadWeak) clearedWeak = card.topic;
    }
    // 复习答错（Again/Hard）→ 回流薄弱点（failCount+1，下次清单/面试优先覆盖）
    // 首刷答错不回流（没学过不算失败——67% 答错率里首刷部分不再污染薄弱点）
    if (ratingNum < 2 && card.topic && !isFirstReview) {
      try {
        memory.addWeakPoint(card.topic, "复习答错", "agent", {
          question: card.question || card.topic,
          answer: card.answer,
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
          .run(JSON.stringify(card.fsrs), dueMs, Date.now(), String(id));
        // 首刷标记（is_first）——错题本/薄弱点排除首刷（复习首刷不计 fail 工单任务 1）
        db.prepare("INSERT INTO card_reviews (card_id, rating, reviewed_at, is_first) VALUES (?, ?, ?, ?)")
          .run(String(id), ratingNum, Date.now(), isFirstReview ? 1 : 0);
      });
    } catch (e) {
      // 写库失败必须透传（不能静默降级为成功——否则 UI 推进但数据未持久化，进度回退且无信号）
      return { ok: false, error: `复习记录写入失败: ${String(e instanceof Error ? e.message : e).slice(0, 120)}` };
    }
    // 学习计划事件流埋点（C7 血缘闭环：复习动作进事件流 → 计划进度/趋势/即时反馈）
    // result 归一：Again=0 → fail、Hard=1 → partial、Good/Easy → pass；quality 归一 0-1
    let tip: string | null = null;
    try {
      const result = ratingNum >= 2 ? "pass" : (ratingNum === 1 ? "partial" : "fail");
      const quality = ratingNum / 3;
      recordLearningEvent({ topic: card.topic, kind: "review", result, quality });
      tip = buildFeedbackTip({ topic: card.topic, kind: "review", result, quality });
    } catch { /* 埋点失败不影响复习主流程 */ }
    return { ok: true, card, nextDue: r.card.due, tip, clearedWeak, isFirst: isFirstReview };
  },

  // 今天到期的卡片
  // 排序：按"到期时间"升序（最久没复习的先——到期越早说明拖得越久，越该先复习）；
  // memPct 相同/接近时用遗忘概率微调。修复：此前按 memPct 排序，唯一复习过的卡（memPct 有值）
  // 恒排新卡（memPct=null）之前 → 推荐永远取同一张卡，复习完也不轮换
  getDueCards(): ReviewCard[] {
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
  getStats(): { total: number; due: number; mastered: number; learning: number; todayDone: number } {
    const data = loadCards();
    const due = this.getDueCards();
    // 今日已完成复习次数（card_reviews 表：今天有评分记录的**卡**数——修复：
    // 此前 COUNT(*) 按行数统计，同一张卡复习多次被重复计数，与"今日复习了 N 张卡"语义不符）
    let todayDone = 0;
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const row = db.prepare("SELECT COUNT(DISTINCT card_id) n FROM card_reviews WHERE reviewed_at >= ?").get(dayStart.getTime());
      todayDone = row ? Number(row.n) || 0 : 0;
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
  getReviewTrend(): { trend: Array<{ date: string; count: number }>; streak: number } {
    const byDay: Record<string, number> = {};
    try {
      for (const r of db.prepare("SELECT reviewed_at FROM card_reviews").all() as unknown as Array<{ reviewed_at: unknown }>) {
        const d = localDateKey(Number(r.reviewed_at));
        byDay[d] = (byDay[d] || 0) + 1;
      }
    } catch { /* ignore */ }
    const out: Array<{ date: string; count: number }> = [];
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
  // 每日复习会话（强化复习工单任务 3：每日限额 + 优先级调度——必会 > 薄弱点 > 其他，最久未复习优先）
  getDailySession(limit = 15): ReviewCard[] {
    const due = this.getDueCards();
    // 薄弱点集合（卡 topic 在薄弱点 → 优先）
    let weakSet = new Set<string>();
    try { weakSet = new Set(memory.getTrustedWeakPoints(50).map((w: { topic?: unknown }) => String(w.topic))); } catch { /* ignore */ }
    const PRIORITY: Record<string, number> = { 必会: 0, 进阶: 1, 拓展: 2 };
    return due
      .map((c) => {
        const dueAt = c.history.length === 0 ? (c.createdAt ? new Date(c.createdAt).getTime() + 24 * 3600 * 1000 : 0) : new Date(c.fsrs.due).getTime();
        return { c, dueAt, overdueDays: Math.max(0, Math.floor((Date.now() - dueAt) / (24 * 3600 * 1000))) };
      })
      .sort((a, b) => {
        // 优先级：必会 > 薄弱点 > 其他；同级按过期天数（最久未复习优先）
        const pa = weakSet.has(a.c.topic) ? 0 : PRIORITY[a.c.priority] ?? 2;
        const pb = weakSet.has(b.c.topic) ? 0 : PRIORITY[b.c.priority] ?? 2;
        if (pa !== pb) return pa - pb;
        return b.overdueDays - a.overdueDays;
      })
      .slice(0, limit)
      .map((x) => x.c);
  },

  // 错题重练队列（强化复习工单任务 2②：again/hard 卡当天/3 天内重练——不等 FSRS 长间隔）
  getRetryQueue(limit = 10): Array<{ id: string; topic: string; question: string; answer: string; type: "algo" | "concept"; priority: string; lastWrongAt: number }> {
    const rows = db.prepare(
      `SELECT r.card_id, c.topic, c.question, c.answer, c.type, c.priority, MAX(r.reviewed_at) last_at, r.rating
       FROM card_reviews r JOIN review_cards c ON c.id = r.card_id
       WHERE r.rating < 2 AND r.reviewed_at >= ? GROUP BY r.card_id
       ORDER BY last_at DESC LIMIT ?`
    ).all(Date.now() - 3 * 24 * 3600 * 1000, limit) as unknown as Array<{ card_id: unknown; topic: unknown; question: unknown; answer: unknown; type: unknown; priority: unknown; last_at: number }>;
    return rows.map((r) => ({
      id: String(r.card_id),
      topic: String(r.topic),
      question: String(r.question ?? ""),
      answer: String(r.answer ?? ""),
      type: r.type === "algo" ? "algo" as const : "concept" as const,
      priority: String(r.priority || "拓展"),
      lastWrongAt: r.last_at,
    }));
  },

  // 复习反馈（强化复习工单任务 2③）：今日复习 N 张 / 掌握 X / 待重练 Y
  getReviewFeedback(): { today: number; mastered: number; retry: number } {
    const today = localDateKey();
    const rows = db.prepare("SELECT rating, reviewed_at FROM card_reviews").all() as unknown as Array<{ rating: unknown; reviewed_at: unknown }>;
    const todayRows = rows.filter((r) => localDateKey(Number(r.reviewed_at)) === today);
    const mastered = todayRows.filter((r) => Number(r.rating) >= 2).length;
    return { today: todayRows.length, mastered, retry: this.getRetryQueue(10).length };
  },

  // 错题本：答错（rating<2）>=2 次的卡片，按错次数降序（错得最多的最该重学）
  // 复习首刷不计 fail 工单任务 1：排除首刷记录（is_first=1——没学过不算失败）
  getWrongCards(limit = 8): Array<{ id: string; topic: string; question: string; wrongCount: number; lastWrongAt: string }> {
    const rows = db.prepare(
      `SELECT r.card_id, c.topic, c.question, COUNT(*) wrong_count, MAX(r.reviewed_at) last_wrong_at
       FROM card_reviews r JOIN review_cards c ON c.id = r.card_id
       WHERE r.rating < 2 AND r.is_first = 0 GROUP BY r.card_id HAVING wrong_count >= 2
       ORDER BY wrong_count DESC, last_wrong_at DESC LIMIT ?`
    ).all(limit) as unknown as Array<{ card_id: unknown; topic: unknown; question: unknown; wrong_count: unknown; last_wrong_at: unknown }>;
    return rows.map((r) => ({
      id: String(r.card_id),
      topic: String(r.topic),
      question: String(r.question ?? ""),
      wrongCount: Number(r.wrong_count),
      lastWrongAt: r.last_wrong_at ? new Date(Number(r.last_wrong_at)).toISOString() : "",
    }));
  },

  // 今日复习过的主题（去重，供「复习完 → 面试检验」）
  getTodayReviewedTopics(): Array<{ topic: string; id: string }> {
    try {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const rows = db.prepare(
        `SELECT DISTINCT c.topic, c.id FROM card_reviews r JOIN review_cards c ON c.id = r.card_id
         WHERE r.reviewed_at >= ? ORDER BY r.reviewed_at DESC LIMIT 12`
      ).all(dayStart.getTime()) as unknown as Array<{ topic: unknown; id: unknown }>;
      return rows.map((r) => ({ topic: String(r.topic), id: String(r.id) }));
    } catch { /* ignore */ }
    return [];
  },
};
