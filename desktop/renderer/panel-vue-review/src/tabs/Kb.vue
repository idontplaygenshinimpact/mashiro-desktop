<!-- Vue 版本地知识库（前端三态并行展示工单任务 3）：同一数据源 /api/knowledge/*，样式复用 .rf-* 词汇 -->
<!-- 🟢 Vue 特色：watch 侦听输入做防抖检索（连续输入只在停顿后发一次请求）+ computed 派生命中统计/高亮分段 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api.js";

const KIND_LABEL = { mianjing: "📄 面经", jiaocheng: "📘 教程", job: "🏢 岗位", doc: "📚 文档", note: "📝 学习", followup: "💬 追问" };

const q = ref("");
const hits = ref([]);
const stats = ref(null);
const busy = ref(false);
const err = ref("");
const searched = ref(false);
const disabled = ref(false);
let timer = null;

async function loadStats() {
  try { stats.value = await api("/api/knowledge/stats"); }
  catch (e) { err.value = String(e?.message || e).slice(0, 80); }
}
onMounted(loadStats);

async function search(query) {
  const text = String(query || "").trim();
  if (text.length < 2) { hits.value = []; searched.value = false; return; }
  busy.value = true;
  err.value = "";
  try {
    const j = await api("/api/knowledge/paragraphs/search", { method: "POST", body: { query: text, topK: 8 } });
    disabled.value = !!j?.disabled;
    hits.value = j?.hits || [];
    searched.value = true;
  } catch (e) {
    err.value = "检索失败：" + String(e?.message || e).slice(0, 80);
    hits.value = [];
  } finally {
    busy.value = false;
  }
}

// 🟢 Vue 特色：watch 侦听 + 防抖（连续输入只在停顿 250ms 后检索一次）
watch(q, (v) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => search(v), 250);
});

const terms = computed(() => q.value.trim().split(/\s+/).filter((t) => t.length >= 2));
const followupCount = computed(() => hits.value.filter((h) => h.kind === "followup").length);
const kindText = computed(() => (stats.value?.byKind || []).map((k) => `${KIND_LABEL[k.kind] || k.kind} ${k.n}`).join(" · "));
/** 命中片段高亮分段（computed 派生——不拼 HTML 串） */
function segments(content) {
  const text = String(content || "").slice(0, 220);
  const list = terms.value;
  if (!list.length) return [text];
  const re = new RegExp(`(${list.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re);
}
const isHit = (p) => terms.value.some((t) => t.toLowerCase() === String(p).toLowerCase());
</script>

<template>
  <div class="rf-stack">
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">🧠 本地知识库 · Vue 版</b>
        <span v-if="busy" class="rf-muted">🔍 检索中…</span>
      </div>
      <div style="display:flex;gap:6px">
        <input class="rf-input rf-grow" v-model="q" placeholder="搜索：事件循环 / React Hooks / 防抖节流…" aria-label="知识库检索关键词" />
        <button type="button" class="rf-btn" @click="q = ''">清空</button>
      </div>
      <div class="rf-muted" style="margin-top:6px">
        {{ stats ? `📦 ${stats.total ?? 0} 条${kindText ? `（${kindText}）` : ""}${stats.enabled === false ? " · 未启用（设置可开）" : " · 段落级混合检索"}` : "⏳ 读取库状态…" }}
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn" style="margin-top:6px">⚠️ {{ err }}</div>
    </div>

    <div class="rf-card">
      <div v-if="disabled" class="rf-muted">📭 知识库未启用——到「⚙️ 设置」开启后可搜索</div>
      <div v-else-if="!hits.length" class="rf-muted">
        {{ searched ? "没有命中——换个说法试试（段落级检索：先切段再召回）" : "输入 ≥2 个字开始检索（结果按段落召回，追问段优先）" }}
      </div>
      <template v-else>
        <div class="rf-muted">
          命中 {{ hits.length }} 段（{{ stats?.docs ?? 0 }} 篇文档 · {{ stats?.followups ?? 0 }} 段追问）{{ followupCount ? ` · 追问段 ${followupCount} 段优先` : "" }}
        </div>
        <div v-for="(h, i) in hits" :key="`${h.docId}-${i}`" class="rf-sub" style="margin-top:6px">
          <div style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px">
            <span class="rf-chip">{{ h.kind === "followup" ? "💬 追问" : "📝 讲解" }}</span>
            <b>{{ h.docId }}{{ h.section ? ` · ${h.section}` : "" }}</b>
          </div>
          <span class="rf-report">
            <template v-for="(p, j) in segments(h.content)" :key="j">
              <mark v-if="isHit(p)" class="rf-mark">{{ p }}</mark><template v-else>{{ p }}</template>
            </template>
          </span>
        </div>
      </template>
    </div>

    <div class="rf-muted">🟢 Vue 特性：watch + 防抖检索（停顿 250ms 才发请求）+ computed 派生命中统计与高亮分段</div>
  </div>
</template>
