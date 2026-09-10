<!-- Vue 版对话（前端三态并行展示工单任务 3）：同一 IPC 桥（chatSessions/chatMessages/chatStream/chatSessionDelete） -->
<!-- 🟢 Vue 特色：reactive 集中状态（消息/事件/会话）+ v-model 受控输入；审批类阻塞交互复用原生 -->
<script setup>
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";

const state = reactive({ messages: [], events: [] }); // 🟢 reactive：流式高频更新集中一处
const sessions = ref([]);
const sid = ref("");
const text = ref("");   // v-model
const busy = ref(false);
const err = ref("");
const listEl = ref(null);

async function loadSessions() {
  try {
    const r = await window.kanban.chatSessions();
    sessions.value = r?.sessions || [];
    if (!sid.value && sessions.value.length) sid.value = sessions.value[0].id || sessions.value[0].sessionId || "";
  } catch (e) { err.value = "会话列表读取失败：" + String(e?.message || e).slice(0, 60); }
}
onMounted(loadSessions);

watch(sid, async (v) => {
  state.messages = []; state.events = [];
  if (!v) return;
  try {
    const r = await window.kanban.chatMessages(v);
    state.messages = r?.messages || [];
  } catch (e) { err.value = "消息读取失败：" + String(e?.message || e).slice(0, 60); }
}, { immediate: true });

// 流式跟随：新内容到达滚到底
watch(() => [state.messages.length, state.events.length], async () => {
  await nextTick();
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight;
});

async function send() {
  const msg = text.value.trim();
  if (!msg || busy.value) return;
  busy.value = true; err.value = "";
  state.messages.push({ role: "user", content: msg });
  text.value = "";
  try {
    await window.kanban.chatStream(msg, state.messages, (ev) => {
      if (!ev) return;
      if (ev.type === "chunk" || ev.type === "delta") {
        const last = state.messages[state.messages.length - 1];
        if (last?.role === "assistant" && last.streaming) last.content += String(ev.text || ev.content || "");
        else state.messages.push({ role: "assistant", content: String(ev.text || ev.content || ""), streaming: true });
      } else {
        state.events.push({ type: String(ev.type || "event"), text: String(ev.text || ev.message || ev.tool || "").slice(0, 200) });
      }
    }, sid.value || undefined);
    const last = state.messages[state.messages.length - 1];
    if (last?.streaming) last.streaming = false;
    await loadSessions();
  } catch (e) {
    err.value = "发送失败：" + String(e?.message || e).slice(0, 80);
    const last = state.messages[state.messages.length - 1];
    if (last?.streaming) last.streaming = false;
  } finally { busy.value = false; }
}

async function delSession() {
  if (!sid.value) return;
  try { await window.kanban.chatSessionDelete(sid.value); sid.value = ""; state.messages = []; state.events = []; await loadSessions(); }
  catch (e) { err.value = "删除失败：" + String(e?.message || e).slice(0, 60); }
}

/** 🟢 computed 派生：事件按类型归并计数 */
const eventSummary = computed(() => {
  const m = new Map();
  for (const e of state.events) m.set(e.type, (m.get(e.type) || 0) + 1);
  return [...m.entries()].map(([k, n]) => `${k}×${n}`).join(" · ");
});
</script>

<template>
  <div class="rf-stack">
    <div class="rf-card">
      <div class="rf-head">
        <b class="rf-title">💬 对话 · Vue 版</b>
        <span style="display:flex;gap:6px;align-items:center">
          <select class="rf-input" v-model="sid" aria-label="选择会话">
            <option value="">新会话</option>
            <option v-for="s in sessions" :key="s.id || s.sessionId" :value="s.id || s.sessionId">{{ s.title || s.id || s.sessionId }}</option>
          </select>
          <button type="button" class="rf-btn" :disabled="!sid" title="删除当前会话" @click="delSession">🗑 删除</button>
          <button type="button" class="rf-btn" title="审批/工具确认等阻塞式交互在原生渲染层处理" @click="window.switchRenderer?.('chat', 'native')">⚖️ 审批（原生）</button>
        </span>
      </div>
      <div v-if="err" class="rf-muted rf-chip-warn">⚠️ {{ err }}</div>
      <div v-if="eventSummary" class="rf-muted">工具事件：{{ eventSummary }}</div>
    </div>

    <div class="rf-card">
      <div ref="listEl" style="max-height:360px;overflow-y:auto" role="log" aria-label="对话消息" aria-live="polite">
        <div v-if="!state.messages.length && !state.events.length" class="rf-muted">还没有消息——在下面输入并发送（流式回复会实时追加）</div>
        <div v-for="(m, i) in state.messages" :key="`m${i}`" :class="m.role === 'user' ? 'rf-row' : 'rf-sub'" style="margin-top:6px">
          <b class="rf-title">{{ m.role === "user" ? "我" : "助手" }}</b>
          <span v-if="m.streaming" class="rf-chip rf-chip-info">生成中…</span>
          <span class="rf-report" style="display:block;margin-top:4px">{{ m.content }}</span>
        </div>
        <div v-if="state.events.length" class="rf-sub" style="margin-top:6px">
          <b class="rf-title">工具事件时间线</b>
          <div v-for="(e, i) in state.events" :key="`e${i}`" class="rf-muted">{{ e.type }}{{ e.text ? `：${e.text}` : "" }}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:8px">
        <input
          class="rf-input rf-grow"
          v-model="text"
          placeholder="输入消息（Enter 发送）…"
          aria-label="消息输入"
          @keydown.enter.exact.prevent="send"
        />
        <button type="button" class="rf-btn rf-btn-primary" :disabled="busy || !text.trim()" @click="send">{{ busy ? "回复中…" : "发送" }}</button>
      </div>
    </div>

    <div class="rf-muted">🟢 Vue 特性：reactive 集中状态（流式高频更新）+ v-model 输入 + nextTick 滚动跟随；审批复用原生</div>
  </div>
</template>
