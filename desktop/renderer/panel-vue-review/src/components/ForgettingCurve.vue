<template>
  <div class="fc-wrap">
    <div class="fc-title">
      <span>遗忘曲线 R(t) = e<sup>-t/S</sup></span>
      <span class="fc-s">S={{ stability }} 天</span>
    </div>
    <svg :viewBox="`0 0 ${W} ${H}`" class="fc-svg">
      <!-- 网格 -->
      <line v-for="gx in gridX" :key="'gx' + gx" :x1="gx" :x2="gx" y1="6" :y2="H - 16" class="fc-grid" />
      <line v-for="gy in gridY" :key="'gy' + gy" x1="34" :x2="W - 4" :y1="gy" :y2="gy" class="fc-grid" />
      <!-- 历史曲线（评分后稳定性变化，虚线对比） -->
      <path v-for="(h, i) in history" :key="'hist' + i" :d="pathFor(h.stability)" class="fc-hist" />
      <!-- 当前曲线 -->
      <path :d="pathFor(stability)" class="fc-cur" />
      <!-- 轴标签 -->
      <text x="34" :y="H - 4" class="fc-axis">0</text>
      <text x="W - 22" :y="H - 4" class="fc-axis">30天</text>
      <text x="6" y="12" class="fc-axis">100%</text>
    </svg>
    <div class="fc-note">评分后稳定性 S 变化 → 曲线重绘（FSRS 调度机制可视化）</div>
  </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({ stability: Number, history: Array });
const W = 300, H = 96;
const PAD_L = 34, PAD_R = 6, PAD_T = 6, PAD_B = 16;

// R(t) = e^(-t/S)，横轴 0-30 天 → SVG path
function pathFor(S) {
  const s = Math.max(0.1, Number(S) || 0.1);
  const pts = [];
  for (let t = 0; t <= 30; t += 0.5) {
    const x = PAD_L + (t / 30) * (W - PAD_L - PAD_R);
    const y = PAD_T + (1 - Math.exp(-t / s)) * (H - PAD_T - PAD_B);
    pts.push(`${t === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}
const gridX = computed(() => [PAD_L + (W - PAD_L - PAD_R) / 3, PAD_L + 2 * (W - PAD_L - PAD_R) / 3]);
const gridY = computed(() => [PAD_T + (H - PAD_T - PAD_B) / 2, H - PAD_B]);
</script>

<style scoped>
.fc-wrap { margin-top: 4px; }
.fc-title { display: flex; justify-content: space-between; font-size: 12px; color: #2d2a45; font-weight: 600; }
.fc-s { color: #5d48b8; }
.fc-svg { width: 100%; height: auto; display: block; margin-top: 2px; }
.fc-grid { stroke: rgba(109,79,216,.12); stroke-width: 1; }
.fc-cur { stroke: #6d4fd8; stroke-width: 2; fill: none; }
.fc-hist { stroke: rgba(61,180,140,.55); stroke-width: 1.4; fill: none; stroke-dasharray: 4 3; }
.fc-axis { font-size: 9px; fill: #9a97b8; }
.fc-note { font-size: 11px; color: #9a97b8; margin-top: 2px; }
</style>
