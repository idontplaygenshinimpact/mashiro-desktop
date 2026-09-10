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
    <!-- 复习卡消费侧升级工单任务 1：多角度题分块渲染（原理/边界/场景折叠区——逐块回忆） -->
    <div v-if="angleBlocks" class="rc-multi">
      <details v-for="(b, i) in angleBlocks" :key="i" class="rc-angle" :open="i === 0">
        <summary class="rc-angle-summary">{{ angleIcon(b.label) }} {{ b.label }}角度</summary>
        <div class="rc-angle-text">{{ b.text }}</div>
      </details>
    </div>
    <div v-else class="rc-text">{{ card.title }}</div>
    <!-- 复习卡消费侧升级工单任务 2：简答模式（提取练习——输入简答→对照→自评→FSRS） -->
    <div v-if="!flipped && !saDone" class="rc-sa">
      <div class="rc-side-label" style="margin-top:8px;">✍️ 简答自测（先用你自己的话作答）</div>
      <textarea v-model="saInput" rows="3" class="rc-sa-input" placeholder="不查资料，用自己的话回答…"></textarea>
      <button class="rc-sa-check" @click="onSaCheck">📋 对照答案并自评</button>    </div>
    <div v-if="!flipped" class="rc-hint">🧠 先在脑子里作答，再显示答案对照（主动回忆更有效）</div>
    <button v-if="!flipped && saDone" class="rc-show-answer" @click="$emit('flip')">👁️ 显示答案</button>
    <div v-else-if="flipped" class="rc-face rc-back">
      <div class="rc-side-label">答案</div>
      <div class="rc-text rc-answer">{{ card.answer }}</div>
      <!-- 简答自评三档（映射 FSRS：答错→again / 部分对→hard / 答对→good） -->
      <div v-if="saDone" class="rc-sa-self">
        <div class="rc-side-label" style="margin-top:6px;">对照后自评：</div>
        <div class="rc-sa-rates">
          <button class="rc-sa-rate" @click="$emit('rate-sa', 'again')">😵 答错</button>
          <button class="rc-sa-rate" @click="$emit('rate-sa', 'hard')">😕 部分对</button>
          <button class="rc-sa-rate" @click="$emit('rate-sa', 'good')">🙂 答对</button>
          <button class="rc-sa-rate rc-sa-skip" @click="$emit('rate-sa', '')">⏭ 用四级评分</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
const props = defineProps({ card: Object, flipped: Boolean, cardType: { type: String, default: "concept" } });
const emit = defineEmits(["flip", "rate-sa"]);
const code = ref("");
// 简答模式（任务 2）：输入 → 对照（flip 显示答案）→ 自评
const saInput = ref("");
const saDone = ref(false);
function onSaCheck() {
  if (!String(saInput.value || "").trim()) return; // 空输入不引导（先写再对照）
  saDone.value = true;
  emit("flip"); // 显示答案 → 自评按钮出现
}
// 复习卡消费侧升级工单任务 1：多角度题分块（"原理：…；边界：…；场景：…" → 折叠区）
const ANGLE_ICONS = { 原理: "💡", 边界: "⚠️", 场景: "🧩", 易错: "🚨", 总结: "📌", 对比: "⚖️", 应用: "🛠️" };
const angleBlocks = computed(() => {
  const s = String(props.card?.title || "");
  const blocks = [];
  const re = /(原理|边界|场景|易错|总结|对比|应用)[：:]\s*([^；;\n]+)/g;
  let m;
  while ((m = re.exec(s))) blocks.push({ label: m[1], text: m[2].trim() });
  return blocks.length >= 2 ? blocks : null; // 不足 2 块 = 非多角度题（整体显示）
});
function angleIcon(label) { return ANGLE_ICONS[label] || "📖"; }
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
.rc-hint { margin-top: 8px; font-size: 11px; color: #6a6790; }
.rc-sa-input {
  width: 100%; box-sizing: border-box; margin-top: 4px; padding: 6px 8px; border-radius: 6px;
  border: 1px solid rgba(109,79,216,.25); font-size: 12px; font-family: inherit; resize: vertical;
}
.rc-sa-check {
  margin-top: 6px; padding: 4px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
  background: rgba(109,79,216,.10); color: #5d48b8; border: 1px solid rgba(109,79,216,.3);
}
.rc-sa-check:hover { background: rgba(109,79,216,.16); }
.rc-sa-rates { display: flex; gap: 6px; margin-top: 4px; flex-wrap: wrap; }
.rc-sa-rate {
  font-size: 11px; padding: 3px 10px; border-radius: 6px; cursor: pointer;
  background: rgba(109,79,216,.08); color: #5d48b8; border: 1px solid rgba(109,79,216,.3); font-weight: 600;
}
.rc-sa-skip { background: rgba(154,151,184,.08); color: #6a6790; border-color: rgba(154,151,184,.3); }
.rc-multi { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.rc-angle { border: 1px solid rgba(109,79,216,.18); border-radius: 6px; padding: 4px 8px; background: rgba(109,79,216,.03); }
.rc-angle-summary { font-size: 12px; font-weight: 600; color: #5d48b8; cursor: pointer; }
.rc-angle-text { font-size: 12px; color: #3a3a5a; margin-top: 4px; line-height: 1.6; }
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
