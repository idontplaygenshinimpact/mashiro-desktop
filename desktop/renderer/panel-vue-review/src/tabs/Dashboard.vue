<!-- Vue 版求职驾驶舱（前端三态并行展示工单任务 3 起步：Vue 侧从只有复习扩到全 Tab） -->
<!-- 同一数据源 /api/dashboard（与 React 版、原生版同接口）；样式走 panel.css 的 .rf-* 语义词汇 -->
<!-- 🟢 Vue 特色：ref + computed 响应式派生（近 7 天峰值/进度百分比只在依赖变化时重算）+ watch 侦听数据更新 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";

const data = ref(null);
const busy = ref(false);
const err = ref("");
const at = ref("");

async function load() {
  busy.value = true;
  err.value = "";
  try {
    const j = await api("/api/dashboard");
    if (j?.ok) { data.value = j; at.value = new Date().toLocaleTimeString("zh-CN"); }
    else err.value = "后端未就绪——widget 启动后可刷新重试";
  } catch (e) {
    err.value = "加载失败：" + String(e?.message || e).slice(0, 80);
  } finally {
    busy.value = false;
  }
}
onMounted(load);
// 🟢 Vue 特色：watch 侦听——数据更新即重算派生（无需手动触发渲染）
watch(data, () => { /* 派生值由 computed 自动跟随；此处留作扩展点（如数据到了再播动画） */ });

const week = computed(() => data.value?.week || {});
const series = computed(() => data.value?.weekSeries || []);
const report = computed(() => data.value?.report || {});
const progress = computed(() => data.value?.progress || {});
// 🟢 computed 缓存：峰值只在 weekSeries 变化时重算
const maxAct = computed(() => Math.max(1, ...series.value.map((d) => (d.study || 0) + (d.review || 0) + (d.challenge || 0))));
const todayStr = new Date().toISOString().slice(0, 10);
const dayName = (date) => ["日", "一", "二", "三", "四", "五", "六"][new Date(date + "T00:00:00").getDay()] || date.slice(5);
const pctOf = (done, total) => (total ? Math.round((done / total) * 100) : 0);
const reportLines = computed(() => {
  const r = report.value, out = [];
  if (r.highlights?.length) out.push("✅ 本周亮点：" + r.highlights.join("、"));
  if (r.gaps?.length) out.push("⚠️ 待补：" + r.gaps.join("；"));
  return out;
});
const rows = computed(() => [
  { label: "📚 学习清单", done: progress.value.plan?.done, total: progress.value.plan?.total },
  { label: "✍️ 手写/算法题库", done: progress.value.challenges?.done, total: progress.value.challenges?.total },
  { label: "🔁 复习卡掌握", done: progress.value.review?.mastered, total: progress.value.review?.total },
]);
</script>

<template>
  <div class="rf-stack">
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">📊 求职驾驶舱 · Vue 版</b>
        <span style="display:flex;gap:6px;align-items:center">
          <span v-if="at" class="rf-muted">{{ at }} 更新</span>
          <button type="button" class="rf-btn" :disabled="busy" @click="load">{{ busy ? "刷新中…" : "🔄 刷新" }}</button>
        </span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">
        <span class="rf-stat">📚 学习完成 <b class="rf-num">{{ week.studyDone ?? 0 }}</b></span>
        <span class="rf-stat">🔁 复习 <b class="rf-num">{{ week.reviewDone ?? 0 }} 张</b></span>
        <span class="rf-stat">✍️ 刷题 <b class="rf-num">{{ week.challengeDone ?? 0 }} 道</b></span>
        <span class="rf-stat">⏱️ 专注 <b class="rf-num">{{ Math.round(((week.focusMinutes ?? 0) / 60) * 10) / 10 }} 小时</b></span>
        <span class="rf-stat">💼 投递 <b class="rf-num">{{ week.applyCount ?? 0 }} 家</b></span>
        <span class="rf-stat">🎤 面试 <b class="rf-num">{{ week.interviewCount ?? 0 }} 场</b></span>
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn" style="margin-top:8px">⚠️ {{ err }}</div>
    </div>

    <div class="rf-card">
      <b class="rf-title">📈 近 7 天活动</b>
      <div class="rf-muted">绿=学习 · 紫=复习 · 蓝=刷题（柱高按峰值归一）</div>
      <div v-if="!series.length" class="rf-muted" style="margin-top:8px">📭 暂无活动数据</div>
      <div v-else style="display:flex;gap:6px;align-items:flex-end;margin-top:8px">
        <div v-for="d in series" :key="d.date" style="flex:1;text-align:center">
          <div style="display:flex;gap:2px;justify-content:center;align-items:flex-end;height:30px">
            <span class="rf-bar rf-bar-study" :style="{ height: Math.max(2, Math.round(((d.study || 0) / maxAct) * 26)) + 'px', opacity: d.study ? 1 : 0.25 }" :title="`学习 ${d.study || 0}`" />
            <span class="rf-bar rf-bar-review" :style="{ height: Math.max(2, Math.round(((d.review || 0) / maxAct) * 26)) + 'px', opacity: d.review ? 1 : 0.25 }" :title="`复习 ${d.review || 0}`" />
            <span class="rf-bar rf-bar-challenge" :style="{ height: Math.max(2, Math.round(((d.challenge || 0) / maxAct) * 26)) + 'px', opacity: d.challenge ? 1 : 0.25 }" :title="`刷题 ${d.challenge || 0}`" />
          </div>
          <div :class="d.date === todayStr ? 'rf-day rf-day-today' : 'rf-day'">{{ dayName(d.date) }}</div>
        </div>
      </div>
    </div>

    <div class="rf-card">
      <b class="rf-title">📝 本周复盘与下周建议</b>
      <pre class="rf-report">{{ reportLines.join("\n") }}{{ reportLines.length ? "\n\n" : "" }}{{ (report.suggestions || []).join("\n") || (reportLines.length ? "" : "📭 暂无建议") }}</pre>
    </div>

    <div class="rf-card">
      <b class="rf-title">📌 累计进度（闭环总览）</b>
      <div v-for="r in rows" :key="r.label" class="rf-row" style="align-items:center">
        <span class="rf-muted" style="width:110px">{{ r.label }}</span>
        <span class="rf-track rf-grow"><i class="rf-fill" :style="{ width: pctOf(r.done, r.total) + '%' }" /></span>
        <b style="font-size:11px">{{ r.done || 0 }}/{{ r.total || 0 }}</b>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
        <span class="rf-stat">🎯 方向 <b class="rf-num">{{ progress.direction || "未设置" }}</b></span>
        <span class="rf-stat">🔧 薄弱点 <b class="rf-num">{{ progress.weak ?? 0 }}</b></span>
        <span class="rf-stat">🔁 复习到期 <b class="rf-num">{{ progress.review?.due ?? 0 }}</b></span>
      </div>
    </div>

    <div class="rf-muted">🟢 Vue 特性：ref + computed 响应式派生（峰值/百分比只在依赖变化时重算）+ watch 侦听数据更新</div>
  </div>
</template>
