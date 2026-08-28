<template>
  <div class="vr-wrap">
    <div class="vr-head">
      <span class="vr-title">🔁 复习卡 · FSRS 调度</span>
      <span class="vr-count">剩余 {{ remaining }} 张</span>
    </div>

    <div v-if="loading" class="vr-hint">加载中…</div>
    <div v-else-if="error" class="vr-hint vr-err">{{ error }}</div>

    <template v-else-if="current">
      <!-- 卡片翻转 -->
      <ReviewCard :card="current" :flipped="flipped" @flip="flipped = !flipped" />

      <!-- 遗忘曲线（评分后即时重绘） -->
      <ForgettingCurve :stability="curveStability" :history="history" />

      <!-- 调度时间线 -->
      <ScheduleTimeline :history="history" />

      <!-- 评分按钮 -->
      <RatingButtons :flipped="flipped" @rate="onRate" />
    </template>

    <div v-else class="vr-hint vr-done">🎉 本组复习完成（{{ history.length }} 张已调度）</div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useReview } from "./useReview.js";
import ReviewCard from "./components/ReviewCard.vue";
import RatingButtons from "./components/RatingButtons.vue";
import ForgettingCurve from "./components/ForgettingCurve.vue";
import ScheduleTimeline from "./components/ScheduleTimeline.vue";

const { current, flipped, history, loading, error, remaining, load, rate } = useReview();
onMounted(load);

function onRate(key) {
  flipped.value = false;
  rate(key);
}
// 曲线展示当前卡稳定性（修复：此前优先取 history 末条 = 上一张已评卡的 S，与"当前卡"标题不一致。
// 现改为当前卡：评分后 rate() 先更新 current 为新状态 → 曲线即时重绘展示调度结果，随后 next() 切下一张卡。
// history 仍传给 ForgettingCurve 画虚线历史曲线对比 + ScheduleTimeline 展示调度时间线。）
const curveStability = computed(() => current.value?.fsrs?.stability || 1);
</script>

<style scoped>
.vr-wrap { padding: 10px 12px; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
.vr-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.vr-title { font-weight: 700; color: #5d48b8; font-size: 14px; }
.vr-count { font-size: 12px; color: #6a6790; }
.vr-hint { color: #6a6790; font-size: 12px; padding: 16px 0; text-align: center; }
.vr-err { color: #b91c1c; }
.vr-done { color: #2f7a4a; font-weight: 600; }
</style>
