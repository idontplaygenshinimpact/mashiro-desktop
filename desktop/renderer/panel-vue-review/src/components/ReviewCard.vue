<template>
  <div class="rc-card" @click="$emit('flip')">
    <transition name="flip">
      <div v-if="!flipped" key="front" class="rc-face">
        <div class="rc-side-label">题目</div>
        <div class="rc-text">{{ card.title }}</div>
        <div class="rc-hint">点击查看答案</div>
      </div>
      <div v-else key="back" class="rc-face rc-back">
        <div class="rc-side-label">答案</div>
        <div class="rc-text rc-answer">{{ card.answer }}</div>
      </div>
    </transition>
  </div>
</template>

<script setup>
defineProps({ card: Object, flipped: Boolean });
defineEmits(["flip"]);
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
.flip-enter-active, .flip-leave-active { transition: opacity .18s ease, transform .18s ease; }
.flip-enter-from { opacity: 0; transform: rotateY(-14deg); }
.flip-leave-to { opacity: 0; transform: rotateY(14deg); }
</style>
