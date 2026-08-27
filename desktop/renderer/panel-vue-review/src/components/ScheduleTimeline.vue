<template>
  <div class="st-wrap">
    <div class="st-title">调度时间线（interval 增长）</div>
    <div v-if="!history.length" class="st-empty">评分后显示每次调度的间隔增长</div>
    <div v-else class="st-row">
      <template v-for="(h, i) in history" :key="i">
        <div class="st-dot" :style="{ borderColor: colorOf(h.rating) }">
          <div class="st-rating" :style="{ color: colorOf(h.rating) }">{{ labelOf(h.rating) }}</div>
          <div class="st-int">+{{ h.intervalDays }}天</div>
        </div>
        <div v-if="i < history.length - 1" class="st-arrow">→</div>
      </template>
    </div>
    <div v-if="history.length" class="st-foot">
      S: {{ history.map((h) => h.stability).join(" → ") }}（稳定性逐次增长 = 记忆强化）
    </div>
  </div>
</template>

<script setup>
defineProps({ history: Array });
const COLORS = { again: "#e5484d", hard: "#e0a800", good: "#2f7a4a", easy: "#3a7bd5" };
const LABELS = { again: "忘记", hard: "困难", good: "良好", easy: "简单" };
const colorOf = (k) => COLORS[k] || "#6a6790";
const labelOf = (k) => LABELS[k] || k;
</script>

<style scoped>
.st-wrap { margin-top: 8px; }
.st-title { font-size: 12px; color: #2d2a45; font-weight: 600; }
.st-empty { font-size: 11px; color: #9a97b8; margin-top: 4px; }
.st-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
.st-dot { border: 1.5px solid; border-radius: 8px; padding: 3px 8px; background: rgba(255,255,255,.8); text-align: center; }
.st-rating { font-size: 11px; font-weight: 700; }
.st-int { font-size: 10px; color: #6a6790; }
.st-arrow { color: #9a97b8; font-size: 12px; }
.st-foot { margin-top: 6px; font-size: 11px; color: #6a6790; }
</style>
