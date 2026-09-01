<template>
  <!-- 算法题：多维自评 → 映射四级（写代码能力） -->
  <div v-if="cardType === 'algo'" class="algo-review">
    <div v-if="!flipped" class="rb-hint">先手写代码，再对照关键点，最后完成自评</div>
    <template v-else>
      <div v-for="q in ALGO_QUESTIONS" :key="q.key" class="algo-q">
        <div class="algo-label">{{ q.label }}</div>
        <div class="algo-opts">
          <button
            v-for="opt in q.options" :key="opt"
            class="algo-opt" :class="{ active: scores[q.key] === opt }"
            @click="scores[q.key] = opt"
          >{{ opt }}</button>
        </div>
      </div>
      <button class="rb-submit" :disabled="!complete" @click="submitAlgo">✅ 确认自评 → 评分</button>
    </template>
  </div>
  <!-- 概念题：四级评分（记忆强度）——现状保持 -->
  <template v-else>
    <div class="rb-row">
      <button
        v-for="r in RATINGS" :key="r.key"
        class="rb-btn" :class="{ 'rb-off': !flipped }"
        :style="{ borderColor: r.color, color: r.color }"
        @click="$emit('rate', r.key)"
      >{{ r.label }}</button>
    </div>
    <div v-if="!flipped" class="rb-hint">先看答案，再评分（FSRS 四级调度）</div>
  </template>
</template>

<script setup>
import { ref, computed } from "vue";
import { mapAlgoRating } from "../useReview.js";

const RATINGS = [
  { key: "again", label: "忘记" },
  { key: "hard", label: "困难" },
  { key: "good", label: "良好" },
  { key: "easy", label: "简单" },
];
const ALGO_QUESTIONS = [
  { key: "idea", label: "🧠 思路：知道用什么算法/数据结构吗？", options: ["是", "否"] },
  { key: "impl", label: "✍️ 实现：代码写出来了吗？", options: ["完整", "部分", "没写出"] },
  { key: "boundary", label: "🛡️ 边界：边界条件处理了吗（空输入/单元素/大数）？", options: ["是", "否"] },
  { key: "complexity", label: "⚡ 复杂度：时间/空间复杂度分析对吗？", options: ["是", "否"] },
];
const props = defineProps({ flipped: Boolean, cardType: { type: String, default: "concept" } });
const emit = defineEmits(["rate"]);

const scores = ref({ idea: "", impl: "", boundary: "", complexity: "" });
const complete = computed(() => ALGO_QUESTIONS.every((q) => scores.value[q.key] !== ""));

function submitAlgo() {
  if (!complete.value) return;
  const key = mapAlgoRating(scores.value);
  scores.value = { idea: "", impl: "", boundary: "", complexity: "" }; // 重置（下张卡）
  emit("rate", key);
}
</script>

<style scoped>
.rb-row { display: flex; gap: 6px; margin-top: 8px; }
.rb-btn {
  flex: 1; padding: 6px 0; border-radius: 8px; background: rgba(255,255,255,.85);
  font-size: 12px; font-weight: 600; cursor: pointer; border: 1.5px solid;
}
.rb-btn.rb-off { opacity: .45; cursor: not-allowed; }
.rb-hint { margin-top: 6px; font-size: 11px; color: #9a97b8; text-align: center; }
.algo-review { margin-top: 8px; }
.algo-q { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.algo-label { font-size: 11px; color: #2d2a45; font-weight: 600; flex: 1; min-width: 180px; }
.algo-opts { display: flex; gap: 4px; }
.algo-opt {
  font-size: 11px; padding: 2px 10px; border-radius: 6px;
  border: 1px solid rgba(109,79,216,.25); background: rgba(255,255,255,.85); color: #5d48b8; cursor: pointer;
}
.algo-opt.active { background: rgba(109,79,216,.15); border-color: rgba(109,79,216,.5); font-weight: 700; }
.rb-submit {
  width: 100%; margin-top: 8px; padding: 7px 0; border-radius: 8px; cursor: pointer;
  background: rgba(109,79,216,.12); color: #5d48b8; border: 1px solid rgba(109,79,216,.35); font-weight: 700; font-size: 12px;
}
.rb-submit:disabled { opacity: .4; cursor: not-allowed; }
</style>
