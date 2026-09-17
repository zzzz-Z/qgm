<template>
  <div class="session-monitor" :class="{ 'is-warn': isApproachingLimit, 'is-over': isOverLimit }">
    <span v-tooltip="tooltip" class="mono-tag">
      {{ totalTokens.toLocaleString() }} / {{ HARD_LIMIT.toLocaleString() }}
    </span>
    <div class="progress-track">
      <div class="progress-bar" :style="{ width: `${usagePercent}%` }" />
    </div>
    <button
      v-if="isApproachingLimit"
      v-tooltip="isOverLimit ? '已达上限，点击复制交接总结' : '接近上限，点击复制交接总结'"
      class="handoff-btn"
      :class="{ danger: isOverLimit }"
      @click="copyAndHandoff"
    >
      {{ isOverLimit ? '⛔ 交接' : '⚠ 交接' }}
    </button>
    <button v-tooltip="'重置会话（清空本地 token 累计与消息）'" class="reset-btn" @click="resetSession">
      ↺
    </button>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SessionTokenMonitor' })
import { computed, onMounted } from 'vue'
import { HARD_LIMIT, useSessionManager } from '../composables/useSessionManager'

const {
  sessionId,
  totalTokens,
  usagePercent,
  isApproachingLimit,
  isOverLimit,
  copyAndHandoff,
  resetSession,
  restoreFromStorage,
} = useSessionManager()

const tooltip = computed(() =>
  `会话 ${sessionId.value} · ${totalTokens.value} tok · ${usagePercent.value}%`
)

onMounted(() => { restoreFromStorage() })
</script>

<style scoped>
.session-monitor {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-2);
  transition: border-color 0.15s;
}
.session-monitor.is-warn {
  border-color: var(--warning);
  color: var(--warning);
}
.session-monitor.is-over {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-bg);
}
.mono-tag {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.progress-track {
  width: 60px;
  height: 4px;
  background: var(--surface-2);
  border-radius: 2px;
  overflow: hidden;
  flex-shrink: 0;
}
.progress-bar {
  height: 100%;
  background: var(--primary);
  transition:
    width 0.2s ease,
    background 0.2s ease;
}
.is-warn .progress-bar {
  background: var(--warning);
}
.is-over .progress-bar {
  background: var(--danger);
}
.handoff-btn {
  padding: 1px 6px;
  border: 1px solid var(--warning);
  border-radius: 4px;
  background: transparent;
  color: var(--warning);
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
  font-family: inherit;
  line-height: 1.4;
}
.handoff-btn:hover {
  background: var(--warning-bg);
}
.handoff-btn.danger {
  border-color: var(--danger);
  color: var(--danger);
}
.handoff-btn.danger:hover {
  background: var(--danger-bg);
}
.reset-btn {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 12px;
  line-height: 1;
}
.reset-btn:hover {
  color: var(--primary);
  background: var(--primary-bg);
}
</style>
<!-- tooltip-audit -->
