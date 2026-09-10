<!-- Vue 版学习清单（前端三态并行展示工单任务 3）：同一 IPC 桥（studyPlan/studyCheck/studyGenerate） -->
<!-- 🟢 Vue 特色：computed 链式派生（过滤 → 状态流分组 → 进度百分比）+ watch 侦听搜索词做防抖过滤 -->
<script setup>
import { computed, onMounted, ref, watch } from "vue";

const STATE_LABELS = [
  { key: "todo", label: "📥 待学习" },
  { key: "learning", label: "📖 学习中" },
  { key: "learned", label: "✅ 已学（讲解过）" },
  { key: "review", label: "🔁 待复习（复习卡到期）" },
];
const STATE_OPTIONS = [...STATE_LABELS, { key: "mastered", label: "🏆 已掌握" }];

const plan = ref(null);
const busy = ref(false);
const err = ref("");
const q = ref("");
const lv = ref("");
const st = ref("");
const showMastered = ref(false);
let timer = null;

/** 状态流（与原生 loadStudyPlan 的 stateOf 同口径）：待复习 > 已掌握 > 已学 > 学习中 > 待学习 */
function stateOf(it) {
  if (it.reviewDue) return "review";
  if (it.done && it.mastered) return "mastered";
  if (it.done) return "learned";
  if (it.hasFile) return "learning";
  return "todo";
}

async function load() {
  try {
    const r = await window.kanban.studyPlan();
    if (r?.ok) plan.value = r.plan || { date: "", items: [] };
    else err.value = "清单读取失败——后端未就绪";
  } catch (e) { err.value = "清单读取异常：" + String(e?.message || e).slice(0, 80); }
}
onMounted(load);

async function generate() {
  busy.value = true;
  err.value = "";
  try {
    const r = await window.kanban.studyGenerate();
    if (r?.ok === false) err.value = "生成失败：" + String(r.error || r.hint || "未知原因").slice(0, 80);
    else if (r?.addedCount === 0 && r?.note) err.value = r.note;
    await load();
  } catch (e) { err.value = "生成异常：" + String(e?.message || e).slice(0, 80); }
  finally { busy.value = false; }
}

async function toggle(it, checked) {
  try {
    const r = await window.kanban.studyCheck(it.id, checked);
    if (r?.ok === false) { err.value = "勾选失败：" + String(r.error || "").slice(0, 60); return; }
    if (r?.clearedWeak) window.kanban?.notify?.("✨ 薄弱点消灭", `「${r.clearedWeak}」已消灭（清单勾选回流）`);
    await load();
  } catch (e) { err.value = "勾选异常：" + String(e?.message || e).slice(0, 80); }
}

/** 讲解复用原生弹窗（流式+追问+抽屉同一实现，不做第二套） */
function explain(id) {
  try { window.switchRenderer?.("study", "native"); window.showStudyDetail?.(id); }
  catch (e) { window.kanban?.notify?.("🎨 渲染层", "打开讲解失败：" + String(e?.message || e).slice(0, 60)); }
}

const items = computed(() => plan.value?.items || []);
const doneN = computed(() => items.value.filter((i) => i.done).length);
const pct = computed(() => (items.value.length ? Math.round((doneN.value / items.value.length) * 100) : 0));
const filtering = computed(() => Boolean(q.value.trim() || lv.value || st.value));
// 🟢 computed 链：过滤 → 分组
const filtered = computed(() => {
  const query = q.value.trim().toLowerCase();
  return items.value.filter((it) => {
    if (lv.value && it.level !== lv.value) return false;
    if (st.value && stateOf(it) !== st.value) return false;
    if (query && !`${it.topic || ""} ${it.why || ""}`.toLowerCase().includes(query)) return false;
    return true;
  });
});
const groups = computed(() => {
  const g = { todo: [], learning: [], learned: [], review: [], mastered: [] };
  for (const it of filtered.value) g[stateOf(it)].push(it);
  return g;
});
</script>

<template>
  <div class="rf-stack">
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">📋 学习清单 · Vue 版</b>
        <span style="display:flex;gap:6px;align-items:center">
          <span v-if="plan?.date" class="rf-muted">{{ plan.date }}</span>
          <button type="button" class="rf-btn rf-btn-primary" :disabled="busy" @click="generate">{{ busy ? "生成中…" : "✨ 从产出生成清单" }}</button>
        </span>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="rf-muted">📋 学习进度</span>
        <span class="rf-track rf-grow"><i class="rf-fill" :style="{ width: pct + '%' }" /></span>
        <b style="font-size:11px">{{ doneN }}/{{ items.length }}（{{ pct }}%）</b>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <input class="rf-input rf-grow" v-model="q" placeholder="搜索知识点 / 学习理由…" aria-label="搜索清单条目" />
        <select class="rf-input" v-model="lv" aria-label="按级别筛选">
          <option value="">全部级别</option><option value="必会">必会</option><option value="进阶">进阶</option><option value="拓展">拓展</option>
        </select>
        <select class="rf-input" v-model="st" aria-label="按状态筛选">
          <option value="">全部状态</option>
          <option v-for="s in STATE_OPTIONS" :key="s.key" :value="s.key">{{ s.label }}</option>
        </select>
        <span v-if="filtering" class="rf-muted">匹配 {{ filtered.length }}/{{ items.length }}</span>
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn" style="margin-top:6px">⚠️ {{ err }}</div>
    </div>

    <div v-if="items.length === 0" class="rf-card rf-muted">未生成，点「✨ 从产出生成清单」</div>
    <template v-else>
      <div v-for="s in STATE_LABELS" :key="s.key" class="rf-card">
        <template v-if="groups[s.key].length">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <b class="rf-title">{{ s.label }}</b><span class="rf-chip">{{ groups[s.key].length }}</span>
          </div>
          <div v-for="it in groups[s.key]" :key="it.id" class="rf-row rf-row-start">
            <input type="checkbox" :checked="!!it.done" :aria-label="`标记「${it.topic}」${it.done ? '未完成' : '已完成'}`" style="margin-top:2px" @change="toggle(it, $event.target.checked)" />
            <span class="rf-grow">
              <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <b class="rf-title" :style="{ textDecoration: it.done ? 'line-through' : 'none', opacity: it.done ? 0.75 : 1 }">{{ it.topic }}</b>
                <span v-if="it.level" class="rf-chip">{{ it.level }}</span>
                <span v-if="it.grp" class="rf-chip rf-chip-plain">{{ it.grp }}</span>
                <span v-if="it.fromInterview" class="rf-chip rf-chip-warn">面试</span>
                <span v-if="it.reviewDue" class="rf-chip rf-chip-ok">待复习</span>
              </span>
              <span v-if="it.why" class="rf-muted" style="display:block;margin-top:3px">{{ it.why }}</span>
            </span>
            <button type="button" class="rf-btn" title="打开讲解（复用原生弹窗：流式 + 追问）" @click="explain(it.id)">💡 讲解</button>
          </div>
        </template>
      </div>

      <!-- 已掌握折叠区：控制行独立于被折叠内容（否则按钮在折叠块里点不开） -->
      <div v-if="groups.mastered.length" class="rf-card">
        <div style="display:flex;align-items:center;gap:6px">
          <b class="rf-title">🏆 已掌握</b><span class="rf-chip">{{ groups.mastered.length }}</span>
          <button type="button" class="rf-btn" @click="showMastered = !showMastered">{{ showMastered ? "收起" : "展开" }}</button>
        </div>
        <template v-if="showMastered">
          <div v-for="it in groups.mastered" :key="it.id" class="rf-row rf-row-start">
            <input type="checkbox" checked disabled :aria-label="`「${it.topic}」已掌握`" style="margin-top:2px" />
            <span class="rf-grow"><b class="rf-title">{{ it.topic }}</b> <span v-if="it.grp" class="rf-chip rf-chip-plain">{{ it.grp }}</span></span>
            <button type="button" class="rf-btn" @click="explain(it.id)">💡 讲解</button>
          </div>
        </template>
      </div>
    </template>

    <div class="rf-muted">🟢 Vue 特性：computed 链式派生（过滤 → 状态流分组 → 进度）+ 勾选回流薄弱点提示；讲解复用原生实现</div>
  </div>
</template>
