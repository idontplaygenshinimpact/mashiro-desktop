<!-- Vue 版模拟面试（前端三态并行展示工单任务 3 最后一块）：同一 IPC 桥，状态机在 useInterview.js -->
<!-- 🟢 Vue 特色：composable 组织（reactive 状态 + computed 评分派生）+ v-model 配置表单 + Transition 阶段切换 -->
<script setup>
import { onMounted } from "vue";
import { useInterview } from "../useInterview.js";

const { st, config, history, resumable, err, answer, ROLES, start, resume, submit, finish, loadMeta, scoreRows } = useInterview();
onMounted(loadMeta);
</script>

<template>
  <div class="rf-stack">
    <div v-if="err" class="rf-card rf-muted rf-chip-warn">⚠️ {{ err }}</div>

    <!-- setup：配置 -->
    <div v-if="st.phase === 'setup'" class="rf-card">
      <b class="rf-title">🎤 模拟面试 · Vue 版</b>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        <label class="rf-muted" for="vue-iv-position">目标岗位</label>
        <input id="vue-iv-position" class="rf-input" v-model="config.position" placeholder="如：前端实习生 / React 前端" />
        <label class="rf-muted" for="vue-iv-role">面试官风格</label>
        <select id="vue-iv-role" class="rf-input" v-model="config.role">
          <option v-for="r in ROLES" :key="r" :value="r">{{ r }}</option>
        </select>
        <label class="rf-muted" for="vue-iv-focus">重点方向（可选）</label>
        <input id="vue-iv-focus" class="rf-input" v-model="config.focus" placeholder="如：React / 事件循环 / 项目拷打" />
        <label class="rf-muted" for="vue-iv-resume">简历（可选——面试官基于真实项目拷打）</label>
        <textarea id="vue-iv-resume" class="rf-input" v-model="config.resume" rows="3" placeholder="粘贴简历（至少 40 字；留空用设置中心存档简历）" />
      </div>
      <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
        <button type="button" class="rf-btn rf-btn-primary" :disabled="st.busy" @click="start">{{ st.busy ? "启动中…" : "🚀 开始面试" }}</button>
        <button v-if="resumable" type="button" class="rf-btn" @click="resume">↩️ 恢复上次面试（{{ resumable.round || "?" }} 轮）</button>
      </div>
      <div v-if="history.length" style="margin-top:10px">
        <b class="rf-title">历史复盘（{{ history.length }}）</b>
        <div v-for="(h, i) in history.slice(0, 8)" :key="i" class="rf-row">
          <span class="rf-grow">{{ h.position || "面试" }} · {{ h.rounds || 0 }} 轮</span>
          <span class="rf-muted">{{ h.date ? String(h.date).slice(0, 16) : "" }}</span>
        </div>
      </div>
      <div class="rf-muted" style="margin-top:6px">💡 会话中 Ctrl/Cmd + Enter 快速提交回答</div>
    </div>

    <!-- active：会话 -->
    <template v-else-if="st.phase === 'active'">
      <div class="rf-card">
        <div class="rf-head">
          <b class="rf-title">第 {{ st.session?.round || 1 }}/{{ st.session?.totalRounds || "?" }} 轮 · {{ st.session?.roundType || "" }}</b>
          <span class="rf-muted">考察维度：{{ st.session?.dimension || "—" }}</span>
        </div>
        <div class="rf-report">{{ st.session?.question || "" }}</div>
        <div class="rf-muted" style="margin-top:6px">
          <span v-if="st.session?.basis">依据：{{ st.session.basis }} </span>
          <span v-if="st.session?.criteria">· 评分点：{{ st.session.criteria }}</span>
        </div>
      </div>
      <div class="rf-card">
        <textarea class="rf-input" v-model="answer" rows="5" placeholder="作答…（Ctrl/Cmd + Enter 提交）" aria-label="面试作答" @keydown.ctrl.enter.prevent="submit" @keydown.meta.enter.prevent="submit" />
        <div style="display:flex;gap:6px;margin-top:6px">
          <button type="button" class="rf-btn rf-btn-primary" :disabled="st.busy || !answer.trim()" @click="submit">{{ st.busy ? "评分中…" : "提交回答" }}</button>
          <button type="button" class="rf-btn" :disabled="st.busy" @click="finish">结束并生成复盘</button>
        </div>
      </div>
      <div class="rf-card">
        <b class="rf-title">累计评分（{{ st.scores.rounds }} 轮 · 均分 {{ st.scores.total }}）</b>
        <div v-for="[label, v] in scoreRows" :key="label" class="rf-row" style="align-items:center">
          <span class="rf-muted" style="width:80px">{{ label }}</span>
          <span class="rf-track rf-grow"><i class="rf-fill" :style="{ width: (v || 0) + '%' }" /></span>
          <b style="font-size:11px">{{ v || 0 }}</b>
        </div>
      </div>
    </template>

    <!-- finished：复盘 -->
    <template v-else>
      <div class="rf-card">
        <div class="rf-head"><b class="rf-title">📝 面试复盘 · Vue 版</b><span v-if="st.hint" class="rf-muted">{{ st.hint }}</span></div>
        <pre class="rf-report">{{ st.report }}</pre>
      </div>
      <div class="rf-card">
        <b class="rf-title">本次评分（{{ st.scores.rounds }} 轮）</b>
        <div v-for="[label, v] in scoreRows" :key="label" class="rf-row" style="align-items:center">
          <span class="rf-muted" style="width:80px">{{ label }}</span>
          <span class="rf-track rf-grow"><i class="rf-fill" :style="{ width: (v || 0) + '%' }" /></span>
          <b style="font-size:11px">{{ v || 0 }}</b>
        </div>
        <button type="button" class="rf-btn rf-btn-primary" style="margin-top:8px" @click="st.phase = 'setup'">🔄 再来一场</button>
      </div>
    </template>

    <div class="rf-muted">🟢 Vue 特性：composable（useInterview 状态机）+ reactive/computed 派生 + v-model 配置表单</div>
  </div>
</template>
