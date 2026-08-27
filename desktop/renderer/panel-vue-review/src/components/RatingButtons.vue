<template>
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

<script setup>
const RATINGS = [
  { key: "again", label: "忘记" },
  { key: "hard", label: "困难" },
  { key: "good", label: "良好" },
  { key: "easy", label: "简单" },
];
defineProps({ flipped: Boolean });
defineEmits(["rate"]);
</script>

<style scoped>
.rb-row { display: flex; gap: 6px; margin-top: 8px; }
.rb-btn {
  flex: 1; padding: 6px 0; border-radius: 8px; background: rgba(255,255,255,.85);
  font-size: 12px; font-weight: 600; cursor: pointer; border: 1.5px solid;
}
.rb-btn.rb-off { opacity: .45; cursor: not-allowed; }
.rb-hint { margin-top: 6px; font-size: 11px; color: #9a97b8; text-align: center; }
</style>
