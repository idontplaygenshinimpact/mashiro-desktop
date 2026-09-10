<!-- Vue 版爬取（前端三态并行展示工单任务 3）：同一 IPC 桥（getData/getStats/runDiscover/openOutput/openFile） -->
<!-- 🟢 Vue 特色：v-model 双向绑定（搜索过滤/表单）+ watch 侦听进度状态驱动轮询（空闲不轮询，仅爬取中 5s 拉取） -->
<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

const data = ref(null);
const stats = ref(null);
const busy = ref(false);
const err = ref("");
const q = ref(""); // v-model 双向绑定
let timer = null;

async function load() {
  try {
    const r = await window.kanban.getData();
    if (r?.ok) data.value = r; else err.value = "读取产出失败——后端未就绪";
  } catch (e) { err.value = "读取产出异常：" + String(e?.message || e).slice(0, 80); }
  try {
    const s = await window.kanban.getStats();
    if (s?.ok) stats.value = s.stats || null;
  } catch { /* 统计失败不影响主视图 */ }
}
onMounted(load);
onUnmounted(() => { if (timer) clearInterval(timer); });

const status = computed(() => data.value?.progress?.status || "idle");
// 🟢 Vue 特色：watch 响应式驱动轮询（状态从别处变化也会自动开始/停止）
watch(status, (v) => {
  if (timer) { clearInterval(timer); timer = null; }
  if (v === "running") timer = setInterval(load, 5000);
}, { immediate: true });

const prog = computed(() => data.value?.progress || {});
const pct = computed(() => (prog.value.status === "running"
  ? (prog.value.total ? Math.min(100, Math.round((prog.value.current / prog.value.total) * 100)) : 8)
  : prog.value.status === "done" ? 100 : 0));
const progressText = computed(() => (prog.value.status === "running" ? `🔍 ${prog.value.message || "爬取中..."}`
  : prog.value.status === "done" ? `✅ ${prog.value.message || "完成"}` : "暂无任务"));
const reco = computed(() => {
  const p = data.value?.plan || {};
  return [...(p.bishi || []).map((f) => ({ ...f, tag: "笔试" })), ...(p.mianshi || []).map((f) => ({ ...f, tag: "面经" }))];
});
/** v-model 搜索过滤（公司/标题） */
const files = computed(() => {
  const query = q.value.trim().toLowerCase();
  const list = data.value?.files || [];
  const hit = query ? list.filter((f) => `${f.company || ""} ${f.title || ""}`.toLowerCase().includes(query)) : list;
  return hit.slice(0, 12);
});

async function startCrawl() {
  busy.value = true; err.value = "";
  try {
    const r = await window.kanban.runDiscover();
    if (r?.ok === false) err.value = "启动爬取失败：" + String(r.error || "").slice(0, 60);
    await load();
  } catch (e) { err.value = "启动爬取异常：" + String(e?.message || e).slice(0, 80); }
  finally { busy.value = false; }
}
</script>

<template>
  <div class="rf-stack">
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">🔍 爬取 · Vue 版</b>
        <span style="display:flex;gap:6px">
          <button type="button" class="rf-btn rf-btn-primary" :disabled="busy" @click="startCrawl">{{ busy ? "启动中…" : "🔍 开始爬取" }}</button>
          <button type="button" class="rf-btn" @click="window.kanban.openOutput()">📁 打开输出目录</button>
          <button type="button" class="rf-btn" @click="load">🔄 刷新</button>
        </span>
      </div>
      <div class="rf-muted">{{ progressText }}</div>
      <div v-if="pct > 0" class="rf-track" style="margin-top:6px">
        <i :class="prog.status === 'done' ? 'rf-fill rf-fill-done' : 'rf-fill'" :style="{ width: pct + '%' }" />
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn" style="margin-top:6px">⚠️ {{ err }}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">
        <span class="rf-chip">💬 对话 {{ stats?.chats || 0 }}</span>
        <span class="rf-chip">📝 复盘 {{ stats?.reviewsDone || 0 }}</span>
        <span class="rf-chip">🎤 面试 {{ stats?.interviewsDone || 0 }}</span>
        <span class="rf-chip">📚 复习 {{ data?.review?.total || 0 }}</span>
      </div>
    </div>

    <div class="rf-card">
      <b class="rf-title">📌 今日推荐</b>
      <div v-if="!reco.length" class="rf-muted" style="margin-top:6px">暂无推荐（先跑一次爬取）</div>
      <div v-for="(f, i) in reco" :key="f.path || f.file || i" class="rf-row" :style="{ cursor: f.path ? 'pointer' : 'default' }" :title="f.path ? '点击用系统默认程序打开' : ''" @click="f.path && window.kanban.openFile(f.path)">
        <span :class="f.tag === '笔试' ? 'rf-chip rf-chip-info' : 'rf-chip rf-chip-warn'">{{ f.tag }}</span>
        <span class="rf-grow">{{ f.title || f.file || "" }}</span>
      </div>
    </div>

    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">📄 最近产出（{{ data?.files?.length || 0 }}）</b>
        <input class="rf-input" v-model="q" placeholder="按公司/标题过滤…" aria-label="过滤产出列表" style="max-width:220px" />
      </div>
      <div v-if="!files.length" class="rf-muted">{{ (data?.files || []).length ? "没有匹配的产出" : "暂无产出" }}</div>
      <div v-for="(f, i) in files" :key="`${f.dir || ''}-${f.title || i}`" class="rf-row">
        <span class="rf-chip">{{ f.company || "?" }}</span>
        <span class="rf-grow">{{ f.title || "" }}</span>
        <span class="rf-muted rf-dir" :title="f.dir || ''">{{ f.dir || "" }}</span>
      </div>
    </div>

    <div class="rf-muted">🟢 Vue 特性：v-model 双向绑定（产出过滤）+ watch 驱动轮询（仅爬取中 5s 拉取，空闲不轮询）</div>
  </div>
</template>
