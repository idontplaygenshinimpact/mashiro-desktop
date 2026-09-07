<template>
  <!-- 算法题：手写模式（看题 → 手写代码 → 对照关键点；不翻转看答案） -->
  <div v-if="cardType === 'algo'" class="rc-card algo-card">
    <div class="rc-side-label">题目</div>
    <div class="rc-text">{{ card.title }}</div>
    <textarea
      v-model="code"
      class="algo-code"
      rows="6"
      placeholder="在这里手写你的代码…（本地练习，不提交评测）"
      spellcheck="false"
    ></textarea>
    <div class="rc-side-label">✍️ 写完后对照答案关键点</div>
    <details class="algo-keys">
      <summary class="algo-keys-summary">📋 对照关键点（点击展开）</summary>
      <ul class="algo-keys-list">
        <li v-for="(k, i) in keyPoints" :key="i">{{ k }}</li>
      </ul>
    </details>
  </div>
  <!-- 概念题：主动回忆（强化复习工单任务 2①——答案默认折叠，点"显示答案"才展开——消除被动回忆） -->
  <div v-else class="rc-card">
    <div class="rc-side-label">题目</div>
    <div class="rc-text">{{ card.title }}</div>
    <div v-if="!flipped" class="rc-hint">🧠 先在脑子里作答，再显示答案对照（主动回忆更有效）</div>
    <button v-if="!flipped" class="rc-show-answer" @click="$emit('flip')">👁️ 显示答案</button>
    <div v-else class="rc-face rc-back">
      <div class="rc-side-label">答案</div>
      <div class="rc-text rc-answer">{{ card.answer }}</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
const props = defineProps({ card: Object, flipped: Boolean, cardType: { type: String, default: "concept" } });
defineEmits(["flip"]);
const code = ref("");
// 对照关键点：答案按行/分点拆（数据结构/算法/边界/复杂度等要点）
const keyPoints = computed(() => {
  const raw = String(props.card?.answer || "");
  return raw
    .split(/\n|；|;/)
    .map((s) => s.trim().replace(/^[-*•\d.、\s]+/, ""))
    .filter((s) => s && s.length >= 2 && s.length <= 60)
    .slice(0, 10);
});
</script>

<style scoped>
.rc-card { perspective: 900px; cursor: pointer; margin-bottom: 10px; }
.rc-face {
  min-height: 84px; padding: 12px 14px; border-radius: 10px;
  background: linear-gradient(135deg, rgba(109,79,216,.10), rgba(109,79,216,.04));
  border: 1px solid rgba(109,79,216,.18);
}
.rc-back { background: linear-gradient(135deg, rgba(47,122,74,.10), rgba(47,122,74,.04)); border-color: rgba(47,122,74,.22); }
.rc-side-label { font-size: 11px; color: #6a6790; margin-bottom: 6px; }
.rc-text { font-size: 13px; color: #2d2a45; line-height: 1.6; font-weight: 600; }
.rc-answer { font-weight: 400; color: #2f4a3a; }
.rc-hint { margin-top: 8px; font-size: 11px; color: #9a97b8; }
.rc-show-answer {
  margin-top: 8px; padding: 5px 14px; border-radius: 8px; cursor: pointer;
  background: rgba(109,79,216,.10); color: #5d48b8; border: 1px solid rgba(109,79,216,.3); font-size: 12px; font-weight: 600;
}
.rc-show-answer:hover { background: rgba(109,79,216,.16); }
.flip-enter-active, .flip-leave-active { transition: opacity .18s ease, transform .18s ease; }
.flip-enter-from { opacity: 0; transform: rotateY(-14deg); }
.flip-leave-to { opacity: 0; transform: rotateY(14deg); }
.algo-card { cursor: default; padding: 12px 14px; border-radius: 10px; background: linear-gradient(135deg, rgba(109,79,216,.10), rgba(109,79,216,.04)); border: 1px solid rgba(109,79,216,.18); }
.algo-code {
  width: 100%; margin: 8px 0; padding: 8px 10px; border-radius: 8px; resize: vertical;
  background: rgba(255,255,255,.92); color: #2d2a45; border: 1px solid rgba(109,79,216,.25);
  font-family: Consolas, "Courier New", monospace; font-size: 12px; line-height: 1.5;
}
.algo-keys { margin-top: 4px; }
.algo-keys-summary { font-size: 12px; color: #5d48b8; cursor: pointer; font-weight: 600; }
.algo-keys-list { margin: 6px 0 0 18px; font-size: 12px; color: #2f4a3a; line-height: 1.7; }
</style>
