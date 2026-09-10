// 复习卡业务状态（FSRS 调度可视化）
// 数据源：面板环境走 window.kanban.reviewDue/reviewSubmit（真实 /api/review）；
//         浏览器 dev 环境（无 kanban）用内置示例数据
// 遗忘曲线与后端同源：FSRS-6 幂律 R(t) = (1+19/81·t/S)^(-0.5)（ts-fsrs forgetting_curve）
import { ref, computed } from "vue";
import { fsrs, Rating, createEmptyCard } from "ts-fsrs";

const scheduler = fsrs();

// ---- 内置示例卡（dev 无数据时演示；标记 demo 隔离——绝不上报后端）----
const DEMO_CARDS = [
  { id: "demo-1", title: "事件循环：宏任务与微任务的执行顺序", answer: "先同步 → 微任务队列 → 宏任务；Promise.then 是微任务，setTimeout 是宏任务。", fsrs: { state: 2, stability: 3.2, difficulty: 5.0, due: daysFromNow(1) } },
  { id: "demo-2", title: "Vue 响应式原理（依赖收集与 effect 调度）", answer: "Proxy 拦截 get 收集依赖（Dep），set 触发更新；effect 依赖追踪，调度器控制更新时机。", fsrs: { state: 2, stability: 1.5, difficulty: 6.2, due: daysFromNow(0) } },
  { id: "demo-3", title: "浏览器缓存：强缓存与协商缓存", answer: "强缓存：Cache-Control max-age 未过期直接命中；协商缓存：ETag/Last-Modified 回源验证。", fsrs: { state: 1, stability: 0.3, difficulty: 4.0, due: daysFromNow(0) } },
  // 算法题示例（type: 'algo' → 手写模式 + 多维自评；answer 含关键点供对照拆解）
  { id: "demo-4", title: "手写防抖节流", type: "algo", answer: "防抖：定时器延迟执行，连续触发重置；节流：时间戳/定时器限频执行。边界：立即执行选项、取消、最后一次触发。复杂度：O(1) 空间、O(1) 时间。", fsrs: { state: 2, stability: 2.0, difficulty: 5.5, due: daysFromNow(0) } },
].map((c) => ({ ...c, demo: true }));
function daysFromNow(d) { const t = new Date(); t.setDate(t.getDate() + d); return t.toISOString(); }

const _RATINGS = [
  { key: "again", label: "忘记", color: "#e5484d" },
  { key: "hard", label: "困难", color: "#e0a800" },
  { key: "good", label: "良好", color: "#3a8d5a" },
  { key: "easy", label: "简单", color: "#3a7bd5" },
];

/** 算法题多维自评 → FSRS 四级（写代码能力判定，非记忆强度）
 * 映射（工单）：思路对+实现完整+边界对+复杂度对 → easy；思路对+实现完整+边界/复杂度有漏 → good；
 *            思路对+实现部分 → hard；思路不对 / 没写出 → again
 * @param {{ idea?: string, impl?: string, boundary?: string, complexity?: string }} s
 * @returns {"easy"|"good"|"hard"|"again"}
 */
export function mapAlgoRating(s) {
  if (s.idea !== "是") return "again";
  if (s.impl === "没写出") return "again";
  if (s.impl === "部分") return "hard";
  if (s.impl === "完整") {
    if (s.boundary === "是" && s.complexity === "是") return "easy";
    return "good";
  }
  return "again";
}
// 提交后端的评分坐标：后端用 ts-fsrs Grades[ratingNum]（0=Again,1=Hard,2=Good,3=Easy）
// ——与本地可视化用的 Rating 枚举（Again=1..Easy=4）是两套坐标，必须显式映射，不能直传枚举值
const RATING_GRADE = { again: 0, hard: 1, good: 2, easy: 3 };

export function useReview() {
  const cards = ref([]);
  const current = ref(null);      // 当前复习卡
  const flipped = ref(false);     // 卡片是否翻转（看答案）
  const history = ref([]);        // 本次会话评分历史 {rating, stability, interval, at}
  const loading = ref(true);
  const error = ref("");
  const feedback = ref({ today: 0, mastered: 0, retry: 0 }); // 复习反馈（强化复习工单任务 2③）
  const retryQueue = ref([]);     // 错题重练队列（任务 2②）
  const lastRating = ref(null);   // 复习首刷不计 fail 工单任务 2：最近一次评分（答错 → 讲解按钮强引导）
  const lastIsFirst = ref(false); // 是否首刷（答错引导更强）

  async function load() {
    loading.value = true;
    error.value = "";
    try {
      const kanban = window.kanban;
      let got = null;
      if (kanban?.reviewDue) {
        const r = await kanban.reviewDue();
        // 真实接口出参是 due 数组（契约 ReviewDueOutput.due）——此前读 r.cards 恒空
        got = (r?.due || []).map(normalize);
        // 功能补全任务 3③④：统计 + 趋势从 reviewDue 响应捕获（stats/trend 字段）
        captureStatsAndTrend(r);
      }
      // 真实接口无数据（widget 未跑/无到期卡）→ 回退示例数据（demo 标记，不上报后端）
      cards.value = got && got.length ? got : DEMO_CARDS.map(normalize);
      // 复习反馈 + 错题重练（强化复习工单任务 2）
      try {
        if (kanban?.reviewFeedback) {
          const fb = await kanban.reviewFeedback();
          if (fb) feedback.value = { today: fb.today || 0, mastered: fb.mastered || 0, retry: fb.retry || 0 };
        }
        if (kanban?.reviewRetry) {
          const rt = await kanban.reviewRetry();
          if (rt?.retry) retryQueue.value = rt.retry.map(normalize);
        }
      } catch { /* 反馈失败不影响复习 */ }
    } catch (e) {
      error.value = String(e?.message || e).slice(0, 100);
      cards.value = DEMO_CARDS.map(normalize);
    }
    loading.value = false;
    next();
  }

  // 归一化：保证 fsrs 字段完整（createEmptyCard 基底 + 真实值覆盖）
  // 真实卡字段（契约 ReviewCard）：topic/question/answer/source/fsrs/memPct/stage/history
  function normalize(c) {
    const f = c.fsrs || {};
    const base = createEmptyCard();
    const dueDate = new Date(f.due);
    return {
      ...c,
      demo: !!c.demo,
      title: c.topic || c.title || "（无题面）", // 真实字段是 topic（此前读 c.title/c.front 取不到）
      answer: c.answer || c.back || "",
      fsrs: {
        ...base,
        state: f.state ?? base.state,
        stability: Number(f.stability) || base.stability,
        difficulty: Number(f.difficulty) || base.difficulty,
        due: Number.isNaN(dueDate.getTime()) ? base.due : dueDate, // 无效日期回落基底（修复恒真表达式）
      },
    };
  }

  function next() {
    flipped.value = false;
    // 到期卡优先（due <= now）
    const now = Date.now();
    const due = cards.value.filter((c) => new Date(c.fsrs.due).getTime() <= now);
    current.value = due[0] || cards.value[0] || null;
  }

  // 评分：真实卡提交后端（数字 0..3 对齐 Grades 坐标）；demo 卡绝不提交；
  // 本地同步更新状态（用 ts-fsrs 重算 stability/interval，曲线立即重绘）
  async function rate(ratingKey) {
    if (!current.value) return;
    const grade = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy }[ratingKey];
    const prev = current.value;
    // 本地 FSRS 重算（与后端同库同参数——展示调度机制）
    const scheduling = scheduler.repeat(prev.fsrs, new Date());
    const record = scheduling[grade].card;
    const intervalDays = Math.max(0, Math.round((new Date(record.due) - new Date()) / 86400000));
    history.value.push({
      rating: ratingKey,
      stability: Math.round(record.stability * 10) / 10,
      intervalDays,
      at: new Date().toISOString(),
    });
    // 更新当前卡状态（曲线重绘）并移除
    current.value = { ...prev, fsrs: { state: record.state, stability: record.stability, difficulty: record.difficulty, due: record.due } };
    cards.value = cards.value.filter((c) => c.id !== prev.id);
    // 真实卡提交后端（await + 结果检查——修复：此前 fire-and-forget 传字符串 rating 被契约
    // 400 拒收且静默失败，card_reviews 永不写入）；demo 卡只本地演示
    if (!prev.demo && window.kanban?.reviewSubmit) {
      try {
        const submit = await window.kanban.reviewSubmit(prev.id, RATING_GRADE[ratingKey]);
        if (submit && submit.ok === false) error.value = String(submit.error || "复习提交失败");
        // 复习首刷不计 fail 工单任务 2：记录答错状态（讲解按钮强引导——首刷"先学再复习"）
        lastRating.value = RATING_GRADE[ratingKey] < 2 ? ratingKey : null;
        lastIsFirst.value = !!submit?.isFirst;
        // 薄弱点消灭进度可视化工单任务 2：答对清除薄弱点 → 正反馈 toast
        if (submit?.clearedWeak) {
          try { window.kanban.notify("🎉 薄弱点已消灭", `「${String(submit.clearedWeak).slice(0, 20)}」已清除——继续加油！`); } catch { /* ignore */ }
        }
      } catch (e) {
        error.value = "复习提交失败：" + String(e?.message || e).slice(0, 80);
      }
    }
    await nextTick();
    next(); // 评分后直接切下一张（不保留已评分卡）
  }

  async function nextTick() { await new Promise((r) => setTimeout(r, 30)); }

  const remaining = computed(() => cards.value.length);

  // 错题重练（强化复习工单任务 2②）：外部替换卡组（重练队列 → 当前卡组）
  function setCards(list) {
    cards.value = (list || []).map(normalize);
    retryQueue.value = [];
    next();
  }

  // ============ Vue 复习面板功能补全工单：选择题自测 / 答错即学 / 错题本 / 掌握度 / 趋势 / 统计 / 入清单 ============
  // API 访问：Vue 独立窗口直接 fetch（getApiBase 动态端口；CSP 已放行 127.0.0.1:*）
  async function api(pathname, { method = "GET", body = undefined } = {}) {
    const base = window.kanban?.getApiBase ? (await window.kanban.getApiBase()).base : "http://127.0.0.1:8899";
    const res = await fetch(`${base}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  }

  // ---- 选择题自测（任务 1：懒生成 6 题抽 3、答错换批——对齐原生 panel-study.js） ----
  const quiz = ref({ questions: [], chosen: {}, results: null, loading: false, error: "", kbUsed: false });
  async function loadQuiz(cardId) {
    if (!cardId) return;
    quiz.value = { questions: [], chosen: {}, results: null, loading: true, error: "", kbUsed: false };
    try {
      let r = await api(`/api/review/quiz?id=${encodeURIComponent(cardId)}`);
      if (!r.questions?.length) {
        // 题库空 → 懒生成（首次约 10-20s；失败降级纯文本卡）
        const g = await api("/api/review/quiz/generate", { method: "POST", body: { cardId } }).catch(() => ({ ok: false }));
        if (g.ok && g.total > 0) {
          r = await api(`/api/review/quiz?id=${encodeURIComponent(cardId)}`);
          quiz.value.kbUsed = !!g.kbUsed;
        } else {
          quiz.value.loading = false;
          return;
        }
      }
      quiz.value.questions = r.questions || [];
      quiz.value.loading = false;
    } catch (e) {
      quiz.value.error = String(e?.message || e).slice(0, 100);
      quiz.value.loading = false;
    }
  }
  function pickQuizOption(qi, oi) {
    quiz.value.chosen = { ...quiz.value.chosen, [qi]: oi };
  }
  async function submitQuiz(cardId) {
    if (!cardId || !quiz.value.questions.length) return;
    quiz.value.loading = true;
    try {
      const answers = quiz.value.questions.map((q, qi) => ({ questionId: q.id, chosen: quiz.value.chosen[qi] ?? -1, map: q.map }));
      const r = await api("/api/review/quiz/submit", { method: "POST", body: { cardId, answers } });
      quiz.value.results = r.results || [];
      quiz.value.loading = false;
    } catch (e) {
      quiz.value.error = String(e?.message || e).slice(0, 100);
      quiz.value.loading = false;
    }
  }
  function resetQuiz() { quiz.value = { questions: [], chosen: {}, results: null, loading: false, error: "", kbUsed: false }; }

  // ---- 答错即学（任务 2①：SSE 流式讲解——复用 /api/review/explain-stream） ----
  const explain = ref({ text: "", loading: false, error: "" });
  async function explainCard(cardId) {
    if (!cardId) return;
    explain.value = { text: "", loading: true, error: "" };
    try {
      const base = window.kanban?.getApiBase ? (await window.kanban.getApiBase()).base : "http://127.0.0.1:8899";
      const res = await fetch(`${base}/api/review/explain-stream?id=${encodeURIComponent(cardId)}`);
      const ctype = res.headers.get("content-type") || "";
      if (!ctype.includes("text/event-stream")) {
        const j = await res.json();
        explain.value.error = j.error || "讲解失败";
        explain.value.loading = false;
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = event.startsWith("data:") ? event.slice(5).trim() : event;
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (j.type === "delta") explain.value.text += j.delta;
            else if (j.type === "error") explain.value.error = j.error || "讲解失败";
          } catch { /* 非 JSON 事件忽略 */ }
        }
      }
      explain.value.loading = false;
    } catch (e) {
      explain.value.error = String(e?.message || e).slice(0, 100);
      explain.value.loading = false;
    }
  }
  function closeExplain() { explain.value = { text: "", loading: false, error: "" }; }

  // ---- 错题本（任务 3①：答错 ≥2 次——复用 /api/review/wrong） ----
  const wrongBook = ref([]);
  async function loadWrongBook() {
    try {
      const r = await api("/api/review/wrong");
      wrongBook.value = (r.wrong || []).map(normalize);
    } catch { wrongBook.value = []; }
  }

  // ---- 掌握度（任务 3②：知识点掌握列表——复用 /api/mastery） ----
  const mastery = ref([]);
  async function loadMastery() {
    try {
      const r = await api("/api/mastery");
      mastery.value = r.mastery || [];
    } catch { mastery.value = []; }
  }

  // ---- 趋势 + 统计（任务 3③④：7 天趋势 + streak + 复习统计——reviewDue 已含 stats/trend） ----
  const stats = ref(null);
  const trend = ref([]);
  function captureStatsAndTrend(dueResp) {
    if (dueResp?.stats) stats.value = dueResp.stats;
    if (dueResp?.trend) trend.value = dueResp.trend;
  }

  // ---- 薄弱点一键入清单（任务 4：复用 /api/weak-points/to-plan） ----
  const toPlanMsg = ref("");
  async function addWeakToPlan(topics) {
    toPlanMsg.value = "";
    try {
      const r = await api("/api/weak-points/to-plan", { method: "POST", body: { topics: topics || [] } });
      toPlanMsg.value = r.message || `已加入学习清单 ${r.added || 0} 条`;
    } catch (e) {
      toPlanMsg.value = "入清单失败：" + String(e?.message || e).slice(0, 80);
    }
  }

  // ---- 薄弱点消灭进度（可视化工单任务 1：已消灭 N 条——累计清除可感知） ----
  const clearedCount = ref(0);
  async function loadClearedCount() {
    try {
      const r = await api("/api/weak-points");
      clearedCount.value = r.clearedCount || 0;
    } catch { clearedCount.value = 0; }
  }

  return { cards, current, flipped, history, loading, error, remaining, feedback, retryQueue, load, rate, next, setCards,
    quiz, loadQuiz, pickQuizOption, submitQuiz, resetQuiz,
    explain, explainCard, closeExplain,
    wrongBook, loadWrongBook, mastery, loadMastery,
    stats, trend, captureStatsAndTrend, toPlanMsg, addWeakToPlan, clearedCount, loadClearedCount,
    lastRating, lastIsFirst };
}
