<!-- Vue 版校招（前端三态并行展示工单任务 3）：同一路由（/api/jobs/recommended、/api/jobs?status=、favorite、status） -->
<!-- 🟢 Vue 特色：v-model 表单（搜索/状态筛选）+ computed 派生可见列表与统计 + 收藏乐观更新 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";

const DIRECTION_LABEL = { frontend: "前端", agent: "AI Agent", fullstack: "全栈", backend: "后端", algorithm: "算法" };
const STATUS_LABEL = { ready: "📮 已投递", ready_bishi: "✍️ 待笔试", none: "未处理" };
const STATUS_FILTERS = [["", "全部"], ["ready", "📮 已投递"], ["ready_bishi", "✍️ 待笔试"], ["none", "未处理"]];

const jobs = ref([]);
const status = ref("");   // v-model
const onlyFav = ref(false);
const q = ref("");        // v-model
const busy = ref(false);
const err = ref("");
const openJd = ref({});

async function load() {
  busy.value = true; err.value = "";
  try {
    const j = status.value ? await api(`/api/jobs?status=${encodeURIComponent(status.value)}`) : await api("/api/jobs/recommended");
    jobs.value = j?.recommended || j?.jobs || [];
  } catch (e) {
    err.value = "岗位读取失败：" + String(e?.message || e).slice(0, 80);
    jobs.value = [];
  } finally { busy.value = false; }
}
onMounted(load);
watch(status, load); // 状态筛选变化即重取（与原生同语义）

async function toggleFav(job) {
  const next = !job.favorite;
  jobs.value = jobs.value.map((x) => (x.id === job.id ? { ...x, favorite: next } : x)); // 乐观更新
  try { await api("/api/jobs/favorite", { method: "POST", body: { id: job.id, favorite: next } }); }
  catch (e) {
    jobs.value = jobs.value.map((x) => (x.id === job.id ? { ...x, favorite: !next } : x)); // 失败回滚
    window.kanban?.notify?.("⭐ 收藏失败", String(e?.message || e).slice(0, 60));
  }
}
async function setJobStatus(job, next) {
  try {
    await api("/api/jobs/status", { method: "POST", body: { id: job.id, status: next } });
    jobs.value = jobs.value.map((x) => (x.id === job.id ? { ...x, status: next } : x));
  } catch (e) { err.value = "状态更新失败：" + String(e?.message || e).slice(0, 60); }
}
/** agent 流程（JD 反推考点/按岗面试）复用原生渲染层，不做两套 */
function openInNative(kind) {
  window.switchRenderer?.("jobs", "native");
  window.kanban?.notify?.("🎨 渲染层", kind === "study" ? "已切回原生渲染层：请在原生界面执行「学考点」" : "已切回原生渲染层：请在原生界面执行「按岗面试」");
}

const visible = computed(() => {
  const query = q.value.trim().toLowerCase();
  return jobs.value.filter((j) => {
    if (onlyFav.value && !j.favorite) return false;
    if (!query) return true;
    return `${j.company || ""} ${j.title || ""} ${j.summary || ""}`.toLowerCase().includes(query);
  });
});
const stats = computed(() => ({
  total: jobs.value.length,
  fav: jobs.value.filter((j) => j.favorite).length,
  applied: jobs.value.filter((j) => j.status === "ready").length,
}));
</script>

<template>
  <div class="rf-stack">
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">🏢 校招岗位 · Vue 版</b>
        <span style="display:flex;gap:6px;align-items:center">
          <span class="rf-muted">{{ stats.total }} 个岗位 · 收藏 {{ stats.fav }} · 已投 {{ stats.applied }}</span>
          <button type="button" class="rf-btn" :disabled="busy" @click="load">{{ busy ? "刷新中…" : "🔄 刷新" }}</button>
        </span>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        <input class="rf-input rf-grow" v-model="q" placeholder="搜索公司 / 岗位 / 摘要…" aria-label="搜索岗位" />
        <select class="rf-input" v-model="status" aria-label="按投递状态筛选">
          <option v-for="[v, label] in STATUS_FILTERS" :key="v" :value="v">{{ label }}</option>
        </select>
        <label class="rf-muted" style="display:flex;align-items:center;gap:4px">
          <input type="checkbox" v-model="onlyFav" aria-label="只看收藏岗位" /> 只看收藏
        </label>
        <button type="button" class="rf-btn" title="搜集校招等抓取操作在原生渲染层" @click="window.switchRenderer?.('jobs', 'native')">🔍 搜集校招（原生）</button>
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn" style="margin-top:6px">⚠️ {{ err }}</div>
    </div>

    <div class="rf-card">
      <div v-if="!visible.length" class="rf-muted">
        {{ jobs.length === 0 ? "暂无岗位——点「🔍 搜集校招」（原生）抓取，或先在设置里填简历/方向" : "没有匹配的岗位，试试清空搜索或换筛选" }}
      </div>
      <div v-for="job in visible" :key="job.id" class="rf-row rf-row-start">
        <span class="rf-grow">
          <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <b class="rf-title">{{ job.company }}</b><span>{{ job.title }}</span>
            <span class="rf-chip">{{ DIRECTION_LABEL[job.direction] || job.direction || "未标方向" }}</span>
            <span class="rf-chip rf-chip-info">匹配 {{ job.match || "—" }}</span>
            <span v-if="job.favorite" class="rf-chip rf-chip-warn">⭐ 收藏</span>
            <span class="rf-chip rf-chip-plain">{{ STATUS_LABEL[job.status] || job.status || "未处理" }}</span>
          </span>
          <span v-if="job.jobType || job.deadline || job.bishiDate" class="rf-muted" style="display:block;margin-top:3px">
            <span v-if="job.jobType">{{ job.jobType }} </span>
            <span v-if="job.deadline">⏰ 截止 {{ job.deadline }} </span>
            <span v-if="job.bishiDate">📝 笔试 {{ job.bishiDate }}</span>
          </span>
          <span v-if="job.summary" class="rf-muted" style="display:block;margin-top:3px">{{ job.summary }}</span>
          <pre v-if="job.jdText && openJd[job.id]" class="rf-report rf-sub" style="margin-top:6px">{{ job.jdText }}</pre>
        </span>
        <span style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
          <button type="button" class="rf-btn" :aria-label="job.favorite ? `取消收藏 ${job.company}` : `收藏 ${job.company}`" @click="toggleFav(job)">{{ job.favorite ? "⭐" : "☆" }}</button>
          <button v-if="job.jdText" type="button" class="rf-btn" :aria-expanded="Boolean(openJd[job.id])" @click="openJd = { ...openJd, [job.id]: !openJd[job.id] }">📋 JD</button>
          <a v-if="job.applyUrl" class="rf-btn" :href="job.applyUrl" target="_blank" rel="noopener noreferrer">🔗 去投递</a>
          <button type="button" class="rf-btn" title="从 JD 反推考点加入学习清单（原生流程）" @click="openInNative('study')">📚 学考点</button>
          <button type="button" class="rf-btn" title="按该岗位 JD 开一场模拟面试（原生流程）" @click="openInNative('interview')">🎤 按岗面试</button>
          <button type="button" class="rf-btn rf-btn-primary" :disabled="job.status === 'ready'" @click="setJobStatus(job, 'ready')">📮 已投递</button>
          <button type="button" class="rf-btn" :disabled="job.status === 'ready_bishi'" @click="setJobStatus(job, 'ready_bishi')">✍️ 待笔试</button>
        </span>
      </div>
    </div>

    <div class="rf-muted">🟢 Vue 特性：v-model 表单（搜索/状态筛选）+ computed 派生可见列表与统计 + 收藏乐观更新（失败回滚）</div>
  </div>
</template>
