<template>
  <Teleport to="body">
    <Transition name="tt-fade">
      <div
        v-if="state.visible"
        class="tt-host"
        :style="{ left: `${state.x}px`, top: `${state.y}px` }"
      >
        {{ state.text }}
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { useTooltip } from '../composables/useTooltip'

const { state } = useTooltip()
</script>

<style scoped>
.tt-host {
  position: fixed;
  z-index: 2147483647;
  transform: translate(12px, 14px);
  max-width: 360px;
  padding: 6px 10px;
  background: rgb(15 23 42 / 96%);
  color: #f8fafc;
  border-radius: 6px;
  font:
    12px/1.5 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  box-shadow: 0 8px 24px rgb(15 30 60 / 28%);
  pointer-events: none;
  word-break: break-word;
  white-space: normal;
  backdrop-filter: blur(6px);
}
.tt-fade-enter-active,
.tt-fade-leave-active {
  transition: opacity 0.12s ease;
}
.tt-fade-enter-from,
.tt-fade-leave-to {
  opacity: 0;
}
html[data-theme='dark'] .tt-host {
  background: rgb(36 45 58 / 96%);
  color: #e8eef5;
}
</style>
