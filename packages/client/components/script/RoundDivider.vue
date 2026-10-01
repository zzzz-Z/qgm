<script setup lang="ts">
// [round-divider-split-v1] 从 TerminalPane 拆出的轮次分隔条子组件
// [WHY] TerminalPane 行数超 §6 上限；本组件无状态、props 单一，优先独立
// [CHANGE-IMPACT] TerminalPane 的 round-divider 分支改为 <RoundDivider />；样式随之迁移
defineProps<{
  roundLabel: string
  timeLabel: string
}>()
</script>

<template>
  <div class="round-divider">
    <span class="round-divider-line" />
    <span class="round-divider-label">{{ roundLabel }}</span>
    <span class="round-divider-line" />
    <span class="round-divider-time">{{ timeLabel }}</span>
  </div>
</template>

<style scoped>
/* [round-divider-split-v1] 样式随模板一起迁出，视觉不变 */
.round-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 0 6px;
  flex: 0 0 auto;
}
.round-divider-line {
  flex: 1 1 auto;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgb(127 127 127 / 22%), transparent);
}
.round-divider-label {
  flex: 0 0 auto;
  padding: 1px 8px;
  border-radius: 999px;
  font: 400 10.5px/1.5 var(--mono, monospace);
  letter-spacing: 0.4px;
  color: var(--text-3, #8b949e);
  background: rgb(127 127 127 / 10%);
  border: 1px solid rgb(127 127 127 / 16%);
}
.round-divider-time {
  flex: 0 0 auto;
  font: 400 10.5px/1.4 var(--mono, monospace);
  color: var(--text-3, #8b949e);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
</style>
