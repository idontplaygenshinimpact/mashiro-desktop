<!-- Vue 版「专项练习」题库 + CodeMirror 6 判题（前端三态并行展示工单任务 3）：
     与原生 panel-rest.js 的题库区共用同一套后端路由 /api/challenges*，
     但编辑器用真正的 CodeMirror 6（不再手搓 textarea）。 -->
<!-- 🟢 Vue 特色：ref + onMounted/onUnmounted 管理 CodeMirror 生命周期（切 Tab 销毁不泄漏）+ computed 派生列表过滤 + v-model 驱动筛选/搜索 -->
<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { api } from "../api.js";
// CodeMirror 6：真正可判题的代码编辑器（三态一致升级的一部分）
import { basicSetup } from "codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";

const DIFF_LABEL = { 1: ["简单", "#1f6b3f"], 2: ["中等", "#7d4a00"], 3: ["困难", "#b91c1c"] };
const freqStars = (n) => "🔥".repeat(Math.max(0, Math.min(3, Number(n) || 0)));

// ---------- 题库列表 ----------
const list = ref([]);
const total = ref(0);
const loading = ref(false);
const err = ref("");
// v-model 驱动的筛选：分类/难度走后端（与原生同口径），是否已做 + 搜索在前端 computed 过滤
// mode：判题模式 switch（核心代码 / ACM），默认 core，走后端 &mode= 参数拉取对应题库列表
const mode = ref("core"); // "core" | "acm"（后端契约：/api/challenges?mode=core|acm）
const cat = ref("");   // "" | handwrite | algorithm
const diff = ref(0);   // 0 全部 | 1 简单 | 2 中等 | 3 困难
const doneFilter = ref(0); // 0 全部 | 1 未做 | 2 已做
const q = ref("");     // 搜索关键词（标题/描述/ID）

// 是否已做筛选是**前端过滤**：后端 /api/challenges 路由只透传 category/difficulty（见 practice.ts），
// 但 getChallenges 返回的每行都带 done 字段 → 在前端 computed 里按 done 过滤，与原生 chDone 同口径
const filtered = computed(() => {
  const query = q.value.trim().toLowerCase();
  return list.value.filter((c) => {
    if (doneFilter.value === 1 && c.done) return false;
    if (doneFilter.value === 2 && !c.done) return false;
    if (query && !`${c.title}\n${c.description || ""}\n${c.id}`.toLowerCase().includes(query)) return false;
    return true;
  });
});
const doneCount = computed(() => list.value.filter((c) => c.done).length);
const pct = computed(() => (total.value ? Math.round((doneCount.value / total.value) * 100) : 0));

async function loadChallenges() {
  loading.value = true;
  err.value = "";
  try {
    const sp = new URLSearchParams();
    sp.set("mode", mode.value); // 判题模式：核心代码 / ACM（后端据此返回对应题库）
    if (cat.value) sp.set("category", cat.value);
    if (diff.value) sp.set("difficulty", String(diff.value));
    const qs = sp.toString();
    const j = await api("/api/challenges" + (qs ? `?${qs}` : ""));
    // 契约：/api/challenges 返回 { ok,total,done,left,list }（list 才是题目数组，不是 challenges）
    list.value = j?.list || [];
    total.value = j?.total ?? list.value.length;
  } catch (e) {
    err.value = "题库读取失败：" + String(e?.message || e).slice(0, 80);
    list.value = [];
  } finally {
    loading.value = false;
  }
}

/** 顶部模式 switch：切换判题模式并重新拉取列表（默认 core） */
function switchMode(m) {
  if (mode.value === m) return; // 点当前已激活的模式无操作
  mode.value = m;
  loadChallenges();
}
onMounted(loadChallenges);

// ---------- 判题编辑器（CodeMirror 6） ----------
// selected：当前展开编题目的列表行；detail：其完整详情（含 skeleton/testCode）
const selected = ref(null);
const detail = ref(null);
const detailLoadErr = ref("");
const editorHost = ref(null);
// 编辑器 View 用裸 let 持有（CM 自建 DOM），不放进 reactive——避免代理污染 Lezer/View 内部对象
let editorView = null;
const running = ref(false);
const runErr = ref("");
const result = ref(null); // { success,error,tests,logs,durationMs,tip,reflow }
const markBusy = ref(false);
const markFlash = ref(""); // 标记完成的临时反馈（展开区内）
const rowFlash = ref({});  // 每行「已会/不会」的独立反馈（未展开行也要如实显示失败）

/** 点开某题：加载详情并挂编辑器（复用已加载列表行的 id） */
async function openChallenge(ch) {
  if (selected.value?.id === ch.id && detail.value) return; // 已展开无需重复
  selected.value = ch;
  detail.value = null;
  detailLoadErr.value = "";
  result.value = null;
  runErr.value = "";
  markFlash.value = "";
  try {
    const j = await api("/api/challenges/detail?id=" + encodeURIComponent(ch.id));
    if (!j?.ok) { detailLoadErr.value = String(j?.error || "加载失败").slice(0, 80); return; }
    detail.value = j.detail;
  } catch (e) {
    detailLoadErr.value = "详情加载失败：" + String(e?.message || e).slice(0, 80);
  }
}

async function closeEditor() {
  selected.value = null;
  detail.value = null;
  result.value = null;
}

/** 创建 CodeMirror 6 编辑器：basicSetup + JS 高亮 + oneDark + Tab 缩进 + Mod-Enter 判题 */
function createEditor(host, initial) {
  return new EditorView({
    parent: host,
    state: EditorState.create({
      doc: String(initial ?? ""),
      extensions: [
        basicSetup, // 行号/历史/折叠/括号匹配/自动补全/搜索 一次到位
        javascript(), // 题库是 JS 判题，词法用 JS 足矣
        oneDark, // 深色主题
        keymap.of([
          indentWithTab, // Tab 缩进（默认 Tab 跳焦点，不可用于编码）
          { key: "Mod-Enter", run: () => { runJudgement(); return true; } }, // Ctrl/Cmd+Enter 快速判题
        ]),
        EditorView.theme({
          "&": { fontSize: "12px", height: "200px", border: "1px solid rgba(109,79,216,.3)", borderRadius: "6px" },
          ".cm-scroller": { fontFamily: "Consolas, Menlo, monospace", lineHeight: "1.55", overflow: "auto" },
          ".cm-content": { caretColor: "#c7a6ff" },
          "&.cm-focused": { outline: "none", borderColor: "rgba(109,79,216,.55)" },
        }),
      ],
    }),
  });
}

/** 详情就绪且编辑器容器渲染后，挂/换编辑器（watch 保证拿到的是最新 detail 的 nextTick DOM） */
watch(detail, async (d, old) => {
  if (editorView) { editorView.destroy(); editorView = null; }
  if (!d) return;
  await nextTick();
  if (editorHost.value) editorView = createEditor(editorHost.value, d.skeleton || "");
});

// onUnmounted 必须 destroy：切 Tab（组件卸载）要释放 CM 的 DOM 监听/观测器，否则重复挂载会泄漏
onUnmounted(() => {
  if (editorView) { editorView.destroy(); editorView = null; }
});

// ---------- 判题 ----------
async function runJudgement() {
  if (!detail.value || !editorView) return;
  const userCode = editorView.state.doc.toString();
  if (!userCode.trim()) { runErr.value = "先写代码再判题"; return; }
  running.value = true;
  runErr.value = "";
  result.value = null;
  markFlash.value = "";
  try {
    const j = await api("/api/challenges/run", { method: "POST", body: { id: detail.value.id, userCode } });
    result.value = j;
    // 判题通过/失败服务端已自动回流（通过→done+进度；失败→wrong_count+薄弱点+复习卡）——
    // 这里如实展示回流结果，不做乐观更新假成功
    await loadChallenges(); // 刷新列表徽标（done/wrongCount）
  } catch (e) {
    runErr.value = "判题调用失败：" + String(e?.message || e).slice(0, 80);
  } finally {
    running.value = false;
  }
}

/** 回流结果文案（reflow：done→已自动标记完成；wrong→已记入错题+复习卡；error→如实显示） */
const reflowNote = computed(() => {
  const r = result.value?.reflow;
  if (!r) return "";
  if (r.error) return "⚠️ 回流失败：" + String(r.error).slice(0, 80);
  if (r.done) return "♻️ 已自动标记完成（题库进度 + 学习进度回流）";
  if (r.wrong) return "♻️ 已记入错题：wrong_count+1 + 薄弱点 + 复习卡";
  return "";
});

/** ACM 逐用例 diff：失败用例且带 input/expected/actual 的，抽出来单独展示「输入/期望/实际」。
 *  为什么抽 computed：判题结果里核心代码模式的测试只有 label，没有三字段；只有 ACM 用例才逐组 diff。 */
const acmFailedCases = computed(() =>
  (result.value?.tests || []).filter((t) => !t.passed && (t.input !== undefined || t.expected !== undefined || t.actual !== undefined))
);

/** ✅ 标记完成：POST mark-done，服务端确认 ok 才更新徽标（失败如实显示，乐观不假成功）。
 *  既可点击列表行的「已会」（传 ch = 该行题目），也可判题通过后点编辑器里的「标记完成」（不传 → 用当前 detail） */
async function markDone(ch) {
  const target = ch || detail.value;
  if (!target?.id) return;
  markBusy.value = true;
  const setMsg = (msg) => { if (!ch) markFlash.value = msg; else rowFlash.value = { ...rowFlash.value, [target.id]: msg }; };
  setMsg("");
  try {
    const j = await api("/api/challenges/mark-done", { method: "POST", body: { id: target.id } });
    setMsg(j?.ok ? `✅ 「${j?.title || target.title}」已标记完成，进度 +1` : `⚠️ ${String(j?.error || "标记失败").slice(0, 80)}`);
    await loadChallenges();
  } catch (e) {
    setMsg("⚠️ 标记失败：" + String(e?.message || e).slice(0, 80));
  } finally {
    markBusy.value = false;
  }
}

/** ❌ 不会：POST mark-wrong，记入薄弱点 + 复习卡（同 markDone：列表行传 ch，编辑器内不传用 detail） */
async function markWrong(ch) {
  const target = ch || detail.value;
  if (!target?.id) return;
  markBusy.value = true;
  const setMsg = (msg) => { if (!ch) markFlash.value = msg; else rowFlash.value = { ...rowFlash.value, [target.id]: msg }; };
  setMsg("");
  try {
    const j = await api("/api/challenges/mark-wrong", { method: "POST", body: { id: target.id } });
    setMsg(j?.ok ? `♻️ 「${j?.title || target.title}」已记入薄弱点 + 复习卡` : `⚠️ ${String(j?.error || "记录失败").slice(0, 80)}`);
    await loadChallenges();
  } catch (e) {
    setMsg("⚠️ 记录失败：" + String(e?.message || e).slice(0, 80));
  } finally {
    markBusy.value = false;
  }
}
</script>

<template>
  <div class="rf-stack">
    <!-- 题库头部：统计 + 筛选 + 搜索 -->
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">✍️ 专项练习 · Vue 版</b>
        <span v-if="loading" class="rf-muted">⏳ 加载题库…</span>
        <span v-else class="rf-muted">📦 {{ total }} 道 · 已完成 {{ doneCount }}（{{ pct }}%）</span>
      </div>
      <!-- 判题模式 switch：核心代码 / ACM（后端按 mode 返回对应题库；切换重新拉列表） -->
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button type="button" class="rf-chip"
                :style="mode === 'core' ? { background: 'rgba(109,79,216,.16)', color: '#5d48b8', border: '1px solid rgba(109,79,216,.45)' } : {}"
                @click="switchMode('core')" aria-label="切到核心代码模式">📐 核心代码</button>
        <button type="button" class="rf-chip"
                :style="mode === 'acm' ? { background: 'rgba(58,141,90,.16)', color: '#1f6b3f', border: '1px solid rgba(58,141,90,.45)' } : {}"
                @click="switchMode('acm')" aria-label="切到 ACM 模式">🖥️ ACM 模式</button>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <input class="rf-input rf-grow" v-model="q" placeholder="搜索题目 / 描述 / ID…" aria-label="搜索题目" />
        <select class="rf-input" v-model="cat" aria-label="按分类筛选" @change="loadChallenges">
          <option value="">全部分类</option>
          <option value="handwrite">✍️ 手写</option>
          <option value="algorithm">🧮 算法</option>
        </select>
        <select class="rf-input" v-model="diff" aria-label="按难度筛选" @change="loadChallenges">
          <option :value="0">全部难度</option>
          <option :value="1">简单</option>
          <option :value="2">中等</option>
          <option :value="3">困难</option>
        </select>
        <select class="rf-input" v-model="doneFilter" aria-label="按是否已做筛选">
          <option :value="0">全部状态</option>
          <option :value="1">🆕 未做</option>
          <option :value="2">✅ 已做</option>
        </select>
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn" style="margin-top:6px">⚠️ {{ err }}</div>
      <div v-if="q.trim() || doneFilter" class="rf-muted" style="margin-top:6px">命中 {{ filtered.length }}/{{ list.length }}</div>
    </div>

    <!-- 题库列表 -->
    <div v-if="!list.length && !loading" class="rf-card rf-muted">题库为空——运行 scripts/import-ai-career.mjs（手写题）或 scripts/import-codetop-top400.mjs（CodeTop 高频 400）导入</div>
    <div v-for="c in filtered" :key="c.id" class="rf-card">
      <div class="rf-row rf-row-start">
        <button type="button" class="rf-btn" style="flex:0 0 auto" @click="openChallenge(c)">✍️ 做题</button>
        <span class="rf-grow">
          <span style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <span class="rf-chip" :style="{ background: c.category === 'handwrite' ? 'rgba(58,141,90,.12)' : 'rgba(109,79,216,.12)', color: c.category === 'handwrite' ? '#1f6b3f' : '#5d48b8' }">{{ c.category === "handwrite" ? "✍️手写" : "🧮算法" }}</span>
            <span v-if="c.mode === 'acm'" class="rf-chip" style="background:rgba(23,116,150,.12);color:#177494">🖥️ ACM</span>
            <span v-if="DIFF_LABEL[c.difficulty]" :style="{ color: DIFF_LABEL[c.difficulty][1], fontSize: '11px' }">{{ DIFF_LABEL[c.difficulty][0] }}</span>
            <span class="rf-muted" :title="`面试出现频率 ${c.frequency}`">{{ freqStars(c.frequency) }}</span>
            <b>{{ c.title }}</b>
            <span v-if="c.done" class="rf-chip rf-chip-ok">✅ 已做</span>
            <span v-if="c.wrongCount > 0" class="rf-chip" style="color:#b91c1c">答错 {{ c.wrongCount }} 次</span>
          </span>
        </span>
        <span v-if="!c.done" style="display:flex;gap:4px;flex-wrap:wrap">
          <button type="button" class="rf-btn" :disabled="markBusy" @click="markDone(c)">✅ 已会</button>
          <button type="button" class="rf-btn" :disabled="markBusy" @click="markWrong(c)">❌ 不会</button>
        </span>
      </div>
      <div v-if="rowFlash[c.id]" class="rf-muted rf-chip-warn" style="margin-top:6px">{{ rowFlash[c.id] }}</div>
      <div v-if="selected?.id === c.id" class="rf-sub" style="margin-top:8px">
        <!-- 题干 -->
        <div v-if="detailLoadErr" class="rf-muted rf-chip-warn">⚠️ {{ detailLoadErr }}</div>
        <div v-else-if="detail">
          <div class="rf-muted" style="display:block;white-space:pre-wrap;margin-bottom:8px;max-height:140px;overflow:auto">{{ detail.description || "(本题暂无题干说明)" }}</div>
          <!-- ACM 题展示可折叠用例区：逐组显示输入/期望输出（<pre> 保留换行），核心代码模式无此区 -->
          <details v-if="detail.mode === 'acm' && (detail.ioCases || []).length"
                   class="rf-sub" style="margin-bottom:8px;font-size:12px">
            <summary style="cursor:pointer;font-weight:600">📥 测试用例（{{ (detail.ioCases || []).length }} 组）</summary>
            <div v-for="(tc, i) in detail.ioCases || []" :key="i"
                 style="margin-top:6px;padding:4px 0;border-top:1px dashed rgba(128,128,128,.25)">
              <span class="rf-muted">用例 {{ i + 1 }} · 输入：</span>
              <pre class="rf-report" style="white-space:pre-wrap;word-break:break-all;margin:2px 0 4px">{{ tc.input }}</pre>
              <span class="rf-muted">期望输出：</span>
              <pre class="rf-report" style="white-space:pre-wrap;word-break:break-all;margin:2px 0 4px">{{ tc.expected }}</pre>
            </div>
          </details>
          <div class="rf-muted" style="margin-bottom:4px;font-size:11px">建议 {{ detail.timeLimit || 10 }} 分钟内完成 · 在骨架里补全实现 · Ctrl/Cmd + Enter 快速判题</div>
          <!-- CodeMirror 6 挂载点（ref editorHost） -->
          <div ref="editorHost"></div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center">
            <button type="button" class="rf-btn rf-btn-primary" :disabled="running" @click="runJudgement">{{ running ? "⏳ 判题中…" : "▶ 运行判题" }}</button>
            <button v-if="result?.success" type="button" class="rf-btn" :disabled="markBusy" @click="markDone">✅ 全部通过，标记完成</button>
            <button v-if="result && !result.success" type="button" class="rf-btn" :disabled="markBusy" @click="markWrong">❌ 不会</button>
            <button type="button" class="rf-btn" @click="closeEditor">✖ 收起</button>
            <span v-if="markFlash" class="rf-muted" style="font-size:12px">{{ markFlash }}</span>
          </div>
          <div v-if="runErr" class="rf-muted rf-chip-warn" style="margin-top:6px">⚠️ {{ runErr }}</div>

          <!-- 判题结果：逐条断言 + 耗时 + console + tip + 回流。失败如实可见，不乐观假成功 -->
          <pre v-if="result" class="rf-report" style="white-space:pre-wrap;word-break:break-all;max-height:260px;overflow:auto;margin-top:8px">{{ result.success ? "🎉 全部通过 ✅" : "❌ 有测试未通过" }}
⏱ {{ result.durationMs }} ms · {{ (result.tests || []).length }} 个测试
{{ (result.tests || []).map((t) => `${t.passed ? "✅" : "❌"} ${t.label || "(用例)"}`).join("\n") }}
{{ result.error ? "⚠️ " + result.error : "" }}{{ (result.logs || []).length ? "\n— console —\n" + result.logs.join("\n") : "" }}{{ result.tip ? "\n💡 " + result.tip : "" }}{{ reflowNote ? "\n" + reflowNote : "" }}</pre>
          <!-- ACM 逐用例 diff：仅失败且带 input/expected/actual 时显示「输入/期望/实际」；全部通过时 acmFailedCases 为空 → 不显示 -->
          <div v-if="acmFailedCases.length" class="rf-report" style="white-space:normal;word-break:break-all;max-height:200px;overflow:auto;margin-top:8px">
            <div v-for="(t, i) in acmFailedCases" :key="i" style="margin-top:4px;padding:4px 0;border-top:1px dashed rgba(128,128,128,.25)">
              <span style="color:#b91c1c;font-weight:600">用例 {{ i + 1 }} 未通过 ⛔</span>
              <div><span class="rf-muted">输入：</span><pre class="rf-report" style="display:inline" v-if="t.input !== undefined">{{ t.input }}</pre></div>
              <div><span class="rf-muted">期望：</span><pre class="rf-report" style="display:inline" v-if="t.expected !== undefined">{{ t.expected }}</pre></div>
              <div><span class="rf-muted">实际：</span><pre class="rf-report" style="display:inline" v-if="t.actual !== undefined">{{ t.actual }}</pre></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="rf-muted">🟢 Vue 特性：ref + onMounted/onUnmounted 管理 CodeMirror 6 生命周期（切 Tab 销毁不泄漏）+ computed 派生列表过滤 + v-model 筛选与搜索</div>
  </div>
</template>
