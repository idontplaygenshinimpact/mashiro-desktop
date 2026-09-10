<template>
  <div class="vr-wrap">
    <div class="vr-head">
      <span class="vr-title">🔁 复习卡 · FSRS 调度</span>
      <span class="vr-count">剩余 {{ remaining }} 张</span>
    </div>
    <div class="vr-sub">Vue 响应式：computed 曲线缓存 · watch 动画 · Transition 切卡（与原生共用业务层）</div>

    <!-- 复习反馈（强化复习工单任务 2③：今日 N 张 / 掌握 X / 待重练 Y——效果可感知） -->
    <div v-if="!loading" class="vr-feedback">
      📊 今日复习 <b>{{ feedback.today }}</b> 张 · 掌握 <b>{{ feedback.mastered }}</b> · 待重练 <b>{{ feedback.retry }}</b>
      <button v-if="retryQueue.length" class="vr-retry-btn" @click="startRetry">🔁 重练错题（{{ retryQueue.length }}）</button>
    </div>

    <div v-if="loading" class="vr-hint">加载中…</div>
    <div v-else-if="error" class="vr-hint vr-err">{{ error }}</div>

    <template v-else-if="current">
      <!-- 卡片切换/翻转动画（框架特色展示工单任务 1①：Vue 招牌 <Transition>——评分切卡/翻转有过渡） -->
      <Transition name="card" mode="out-in">
        <div :key="current.id + (flipped ? '-f' : '-b')" class="vr-card-anim">
          <ReviewCard :card="current" :flipped="flipped" :card-type="current.type" @flip="flipped = !flipped" @rate-sa="onRateSa" />
        </div>
      </Transition>

      <!-- 遗忘曲线（评分后即时重绘；watch 触发曲线动画——任务 1③） -->
      <div :class="{ 'fc-anim': curveAnim }" @animationend="curveAnim = false">
        <ForgettingCurve :stability="curveStability" :history="history" />
      </div>

      <!-- 调度时间线 -->
      <ScheduleTimeline :history="history" />

      <!-- 评分：算法题 → 多维自评映射四级；概念题 → 四级按钮 -->
      <RatingButtons :flipped="flipped" :card-type="current.type" @rate="onRate" />

      <!-- 答错即学（功能补全任务 2①）：💡 讲解按钮 → SSE 流式讲解；复习首刷不计 fail 工单任务 2：答错后强引导 -->
      <div class="vr-explain">
        <button class="vr-explain-btn" :class="{ 'vr-explain-hot': lastRating }" @click="onExplain" :disabled="explain.loading">
          {{ explain.loading ? "⏳ 讲解生成中…" : (lastRating ? (lastIsFirst ? "📖 先学再复习——让真白讲一遍" : "💡 答错了？让真白讲一遍") : "💡 讲解（答错即学）") }}
        </button>
        <div v-if="explain.text" class="vr-explain-body">
          <div class="vr-explain-head">
            <span>📖 讲解</span>
            <button class="vr-close-btn" @click="closeExplain">✕</button>
          </div>
          <div class="vr-explain-text">{{ explain.text }}</div>
        </div>
        <div v-if="explain.error" class="vr-err">{{ explain.error }}</div>
      </div>

      <!-- 选择题自测（功能补全任务 1：懒生成 6 题抽 3、答错换批——最常用功能） -->
      <div class="vr-quiz">
        <div class="vr-quiz-head">
          <span>🧠 复习自测 · 快速回忆</span>
          <button v-if="!quiz.questions.length && !quiz.loading" class="vr-quiz-btn" @click="onQuiz">开始自测</button>
        </div>
        <div v-if="quiz.loading" class="vr-hint">加载/生成中…</div>
        <div v-else-if="quiz.questions.length" class="vr-quiz-body">
          <div v-if="quiz.kbUsed" class="vr-quiz-kb">📚 本题库引用了本地知识库真题素材</div>
          <div v-for="(q, qi) in quiz.questions" :key="q.id" class="vr-quiz-q">
            <div class="vr-quiz-question">{{ qi + 1 }}. {{ q.question }}</div>
            <div class="vr-quiz-options">
              <button v-for="(o, oi) in q.options" :key="oi" class="vr-quiz-opt"
                :class="{ picked: quiz.chosen[qi] === oi, correct: quiz.results && quiz.results[qi]?.correct && quiz.chosen[qi] === oi, wrong: quiz.results && quiz.results[qi]?.correct === false && quiz.chosen[qi] === oi }"
                @click="pickQuizOption(qi, oi)">{{ String.fromCharCode(65 + oi) }}. {{ o }}</button>
            </div>
            <div v-if="quiz.results && quiz.results[qi]" class="vr-quiz-fb" :class="quiz.results[qi].correct ? 'fb-ok' : 'fb-bad'">
              {{ quiz.results[qi].correct ? "✅ 答对" : "❌ 答错" }}：{{ quiz.results[qi].explain || "" }}
            </div>
          </div>
          <button v-if="!quiz.results" class="vr-quiz-submit" @click="onQuizSubmit" :disabled="quiz.loading">✅ 提交自测</button>
          <button v-else class="vr-quiz-btn" @click="onQuiz">🔄 换一批再测</button>
        </div>
        <div v-if="quiz.error" class="vr-err">{{ quiz.error }}</div>
      </div>
    </template>

    <div v-else class="vr-done-panel">
      <div class="vr-hint vr-done">🎉 本组复习完成（{{ history.length }} 张已调度）</div>
      <!-- 薄弱点消灭进度（可视化工单任务 1：已消灭 N 条——累计清除可感知） -->
      <div v-if="clearedCount > 0" class="vr-cleared">🏆 已消灭薄弱点 <b>{{ clearedCount }}</b> 条——进步看得见！</div>
      <!-- 面试检验（功能补全任务 2②）：复习完 → 跳转面试 -->
      <button class="vr-interview-btn" @click="goInterview">🎯 面试检验（复习完去面试）</button>
      <!-- 薄弱点一键入清单（功能补全任务 4） -->
      <button class="vr-plan-btn" @click="onToPlan">📥 薄弱点一键入清单</button>
      <div v-if="toPlanMsg" class="vr-plan-msg">{{ toPlanMsg }}</div>

      <!-- 复习统计（功能补全任务 3④：总卡/到期/今日/已掌握 + 进度条） -->
      <div v-if="stats" class="vr-stats">
        <div class="vr-stats-title">📊 复习统计</div>
        <div class="vr-stats-row">
          <span>总卡 <b>{{ stats.total || 0 }}</b></span>
          <span>到期 <b>{{ stats.due || 0 }}</b></span>
          <span>今日 <b>{{ stats.today || 0 }}</b></span>
          <span>已掌握 <b>{{ stats.mastered || 0 }}</b></span>
        </div>
        <div class="vr-progress"><div class="vr-progress-bar" :style="{ width: masteredPct + '%' }"></div></div>
        <div class="vr-progress-label">掌握进度 {{ masteredPct }}%</div>
      </div>

      <!-- 7 天趋势 + streak（功能补全任务 3③） -->
      <div v-if="trend.length" class="vr-trend">
        <div class="vr-stats-title">📈 7 天复习趋势</div>
        <div class="vr-trend-bars">
          <div v-for="(t, i) in trend" :key="i" class="vr-trend-bar-wrap" :title="`${t.date}：${t.count} 张`">
            <div class="vr-trend-bar" :style="{ height: Math.min(100, (t.count / trendMax) * 100) + '%' }"></div>
            <div class="vr-trend-day">{{ (t.date || "").slice(5) }}</div>
          </div>
        </div>
      </div>

      <!-- 错题本（功能补全任务 3①：答错 ≥2 次） -->
      <div v-if="wrongBook.length" class="vr-wrong">
        <div class="vr-stats-title">📕 错题本（答错 ≥2 次）</div>
        <div v-for="w in wrongBook" :key="w.id" class="vr-wrong-item">
          <span class="vr-wrong-topic">{{ w.topic }}</span>
          <button class="vr-wrong-btn" @click="startWrongRetry(w)">🔁 重练</button>
        </div>
      </div>

      <!-- 掌握度（功能补全任务 3②：知识点掌握列表） -->
      <div v-if="mastery.length" class="vr-mastery">
        <div class="vr-stats-title">🧭 知识点掌握度</div>
        <div v-for="m in mastery.slice(0, 10)" :key="m.id" class="vr-mastery-item">
          <span class="vr-mastery-name">{{ m.title }}</span>
          <div class="vr-mastery-bar-wrap"><div class="vr-mastery-bar" :style="{ width: Math.min(100, m.score || 0) + '%' }"></div></div>
          <span class="vr-mastery-score">{{ m.score || 0 }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useReview } from "./useReview.js";
import ReviewCard from "./components/ReviewCard.vue";
import RatingButtons from "./components/RatingButtons.vue";
import ForgettingCurve from "./components/ForgettingCurve.vue";
import ScheduleTimeline from "./components/ScheduleTimeline.vue";

const { current, flipped, history, loading, error, remaining, feedback, retryQueue, load, rate, setCards,
  quiz, loadQuiz, pickQuizOption, submitQuiz, resetQuiz,
  explain, explainCard, closeExplain,
  wrongBook, loadWrongBook, mastery, loadMastery,
  stats, trend, captureStatsAndTrend, toPlanMsg, addWeakToPlan, clearedCount, loadClearedCount,
  lastRating, lastIsFirst } = useReview();

onMounted(async () => {
  await load();
  // 功能补全任务 3③④：统计 + 趋势从 reviewDue 响应捕获（load 内部已拿——通过 reviewDue 的 stats/trend）
  // 错题本 + 掌握度独立加载
  loadWrongBook();
  loadMastery();
  loadClearedCount(); // 薄弱点消灭进度（可视化工单任务 1）
});

function onRate(key) {
  flipped.value = false;
  rate(key);
}

// 复习卡消费侧升级工单任务 2：简答自评三档（答错→again / 部分对→hard / 答对→good）——映射 FSRS
// key 为空 = 跳过简答自评（用下方四级按钮）
function onRateSa(key) {
  if (!key) { flipped.value = false; return; }
  rate(key);
}

// 错题重练（强化复习工单任务 2②）：重练队列 → 作为当前卡组（评分后正常调度）
function startRetry() {
  if (!retryQueue.value.length) return;
  setCards(retryQueue.value);
}
// 曲线展示当前卡稳定性（修复：此前优先取 history 末条 = 上一张已评卡的 S，与"当前卡"标题不一致。
// 现改为当前卡：评分后 rate() 先更新 current 为新状态 → 曲线即时重绘展示调度结果，随后 next() 切下一张卡。
// history 仍传给 ForgettingCurve 画虚线历史曲线对比 + ScheduleTimeline 展示调度时间线。）
const curveStability = computed(() => current.value?.fsrs?.stability || 1);

// 框架特色展示工单任务 1③：watch 侦听器——评分后（history 增长）触发曲线动画（响应式即时更新）
const curveAnim = ref(false);
watch(() => history.value.length, (n, prev) => {
  if (n > (prev || 0)) curveAnim.value = true; // 新评分 → 曲线过渡动画
});

// ---- 功能补全：选择题自测 ----
function onQuiz() {
  resetQuiz();
  if (current.value) loadQuiz(current.value.id);
}
function onQuizSubmit() {
  if (current.value) submitQuiz(current.value.id);
}

// ---- 功能补全：答错即学（SSE 讲解） ----
function onExplain() {
  if (current.value) explainCard(current.value.id);
}

// ---- 功能补全：面试检验（跳转面试——复用原生 renderReviewTestBtn 语义） ----
function goInterview() {
  try { window.kanban?.gotoPanelTab?.("interview"); } catch { /* 独立窗口无面板跳转 */ }
  // 独立窗口：提示用户回主面板面试区
  alert("请回到主面板「🎤 面试」Tab 开始面试检验（本窗口为复习专用）");
}

// ---- 功能补全：薄弱点一键入清单 ----
function onToPlan() {
  addWeakToPlan([]); // topics 空 = 全部薄弱点
}

// ---- 功能补全：错题本重练 ----
function startWrongRetry(w) {
  setCards([w]);
}

// ---- 统计进度条 ----
const masteredPct = computed(() => {
  if (!stats.value?.total) return 0;
  return Math.min(100, Math.round(((stats.value.mastered || 0) / stats.value.total) * 100));
});
const trendMax = computed(() => Math.max(1, ...(trend.value || []).map((t) => t.count || 0)));
</script>

<style scoped>
.vr-wrap { padding: 10px 12px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
.vr-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.vr-title { font-weight: 700; color: #5d48b8; font-size: 14px; }
.vr-sub { font-size: 10px; color: #9a97b8; margin-bottom: 6px; }
.vr-count { font-size: 12px; color: #6a6790; }
.vr-hint { color: #6a6790; font-size: 12px; padding: 16px 0; text-align: center; }
.vr-err { color: #b91c1c; }
.vr-done { color: #2f7a4a; font-weight: 600; }
.vr-feedback {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px;
  padding: 5px 10px; border-radius: 8px; font-size: 11px; color: #5a5678;
  background: linear-gradient(135deg, rgba(109,79,216,.08), rgba(80,160,255,.05));
  border: 1px solid rgba(109,79,216,.14);
}
.vr-retry-btn {
  font-size: 11px; padding: 2px 10px; border-radius: 6px; cursor: pointer;
  background: rgba(229,72,77,.10); color: #c0392b; border: 1px solid rgba(229,72,77,.3); font-weight: 600;
}
.vr-retry-btn:hover { background: rgba(229,72,77,.16); }

/* 答错即学 */
.vr-explain { margin-top: 10px; }
.vr-explain-btn {
  font-size: 12px; padding: 4px 12px; border-radius: 6px; cursor: pointer;
  background: rgba(58,125,213,.10); color: #2f6fb0; border: 1px solid rgba(58,125,213,.3); font-weight: 600;
}
.vr-explain-btn:hover { background: rgba(58,125,213,.16); }
.vr-explain-hot {
  background: rgba(229,72,77,.12); color: #c0392b; border-color: rgba(229,72,77,.4);
  animation: vr-pulse 1.2s ease infinite;
}
@keyframes vr-pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(229,72,77,.25); } 50% { box-shadow: 0 0 0 4px rgba(229,72,77,.08); } }
.vr-explain-body {
  margin-top: 6px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.6;
  background: rgba(58,125,213,.05); border: 1px solid rgba(58,125,213,.15); color: #3a3a5a;
  max-height: 300px; overflow-y: auto; white-space: pre-wrap;
}
.vr-explain-head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; color: #2f6fb0; margin-bottom: 4px; }
.vr-close-btn { border: none; background: none; cursor: pointer; color: #6a6790; font-size: 12px; }

/* 选择题自测 */
.vr-quiz { margin-top: 10px; padding: 8px 10px; border-radius: 8px; background: rgba(109,79,216,.04); border: 1px solid rgba(109,79,216,.12); }
.vr-quiz-head { display: flex; justify-content: space-between; align-items: center; font-weight: 700; color: #5d48b8; font-size: 12px; margin-bottom: 6px; }
.vr-quiz-btn {
  font-size: 11px; padding: 2px 10px; border-radius: 6px; cursor: pointer;
  background: rgba(109,79,216,.10); color: #5d48b8; border: 1px solid rgba(109,79,216,.3); font-weight: 600;
}
.vr-quiz-kb { font-size: 11px; color: #6a6790; margin-bottom: 4px; }
.vr-quiz-q { margin-bottom: 8px; }
.vr-quiz-question { font-size: 12px; color: #3a3a5a; margin-bottom: 4px; }
.vr-quiz-options { display: flex; flex-direction: column; gap: 3px; }
.vr-quiz-opt {
  text-align: left; font-size: 11px; padding: 3px 8px; border-radius: 5px; cursor: pointer;
  background: #fff; color: #3a3a5a; border: 1px solid #d8d4ea;
}
.vr-quiz-opt:hover { border-color: #9a8fd0; }
.vr-quiz-opt.picked { border-color: #5d48b8; background: rgba(109,79,216,.08); }
.vr-quiz-opt.correct { border-color: #2f7a4a; background: rgba(47,122,74,.10); }
.vr-quiz-opt.wrong { border-color: #c0392b; background: rgba(192,57,43,.10); }
.vr-quiz-fb { font-size: 11px; margin-top: 3px; }
.fb-ok { color: #2f7a4a; }
.fb-bad { color: #c0392b; }
.vr-quiz-submit {
  font-size: 12px; padding: 4px 14px; border-radius: 6px; cursor: pointer;
  background: rgba(47,122,74,.10); color: #2f7a4a; border: 1px solid rgba(47,122,74,.3); font-weight: 600;
}

/* 完成面板 */
.vr-done-panel { display: flex; flex-direction: column; gap: 8px; }
.vr-cleared {
  padding: 6px 10px; border-radius: 8px; font-size: 12px; font-weight: 600; color: #2f7a4a;
  background: linear-gradient(135deg, rgba(47,122,74,.10), rgba(80,160,255,.05));
  border: 1px solid rgba(47,122,74,.2);
}
.vr-interview-btn {
  font-size: 12px; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  background: rgba(229,72,77,.10); color: #c0392b; border: 1px solid rgba(229,72,77,.3); font-weight: 600;
}
.vr-plan-btn {
  font-size: 12px; padding: 6px 14px; border-radius: 6px; cursor: pointer;
  background: rgba(109,79,216,.10); color: #5d48b8; border: 1px solid rgba(109,79,216,.3); font-weight: 600;
}
.vr-plan-msg { font-size: 11px; color: #2f7a4a; }

/* 统计 */
.vr-stats, .vr-trend, .vr-wrong, .vr-mastery {
  padding: 8px 10px; border-radius: 8px; background: rgba(109,79,216,.04); border: 1px solid rgba(109,79,216,.12);
}
.vr-stats-title { font-weight: 700; color: #5d48b8; font-size: 12px; margin-bottom: 6px; }
.vr-stats-row { display: flex; gap: 12px; font-size: 11px; color: #5a5678; margin-bottom: 6px; }
.vr-progress { height: 6px; border-radius: 3px; background: #e8e4f5; overflow: hidden; }
.vr-progress-bar { height: 100%; background: linear-gradient(90deg, #5d48b8, #7a6ad0); border-radius: 3px; }
.vr-progress-label { font-size: 10px; color: #6a6790; margin-top: 3px; }

/* 趋势 */
.vr-trend-bars { display: flex; align-items: flex-end; gap: 6px; height: 60px; }
.vr-trend-bar-wrap { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
.vr-trend-bar { width: 70%; background: linear-gradient(180deg, #7a6ad0, #5d48b8); border-radius: 3px 3px 0 0; min-height: 2px; }
.vr-trend-day { font-size: 9px; color: #6a6790; margin-top: 2px; }

/* 错题本 */
.vr-wrong-item { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 12px; color: #3a3a5a; }
.vr-wrong-btn {
  font-size: 10px; padding: 1px 8px; border-radius: 5px; cursor: pointer;
  background: rgba(229,72,77,.10); color: #c0392b; border: 1px solid rgba(229,72,77,.3);
}

/* 掌握度 */
.vr-mastery-item { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 11px; color: #3a3a5a; }
.vr-mastery-name { width: 90px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vr-mastery-bar-wrap { flex: 1; height: 5px; border-radius: 3px; background: #e8e4f5; overflow: hidden; }
.vr-mastery-bar { height: 100%; background: linear-gradient(90deg, #3a8d5a, #5db87a); border-radius: 3px; }
.vr-mastery-score { width: 24px; text-align: right; color: #6a6790; }

/* 框架特色展示工单任务 1①：卡片切换/翻转 Transition 动画 */
.vr-card-anim { width: 100%; }
.card-enter-active, .card-leave-active { transition: opacity .18s ease, transform .18s ease; }
.card-enter-from { opacity: 0; transform: translateX(14px); }
.card-leave-to { opacity: 0; transform: translateX(-14px); }

/* 任务 1③：评分后曲线动画（watch 触发） */
.fc-anim .fc-cur { animation: fc-draw .5s ease; }
@keyframes fc-draw { from { stroke-dasharray: 400; stroke-dashoffset: 400; } to { stroke-dasharray: 400; stroke-dashoffset: 0; } }
</style>
