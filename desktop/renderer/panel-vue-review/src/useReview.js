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
].map((c) => ({ ...c, demo: true }));
function daysFromNow(d) { const t = new Date(); t.setDate(t.getDate() + d); return t.toISOString(); }

const RATINGS = [
  { key: "again", label: "忘记", color: "#e5484d" },
  { key: "hard", label: "困难", color: "#e0a800" },
  { key: "good", label: "良好", color: "#3a8d5a" },
  { key: "easy", label: "简单", color: "#3a7bd5" },
];
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
      }
      // 真实接口无数据（widget 未跑/无到期卡）→ 回退示例数据（demo 标记，不上报后端）
      cards.value = got && got.length ? got : DEMO_CARDS.map(normalize);
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
      } catch (e) {
        error.value = "复习提交失败：" + String(e?.message || e).slice(0, 80);
      }
    }
    await nextTick();
    next(); // 评分后直接切下一张（不保留已评分卡）
  }

  async function nextTick() { await new Promise((r) => setTimeout(r, 30)); }

  const remaining = computed(() => cards.value.length);

  return { cards, current, flipped, history, loading, error, remaining, load, rate, next };
}
