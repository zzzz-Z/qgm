<script setup lang="ts">
// [script-card-split-v1] 从 TerminalPane 拆出的脚本卡片子组件
// [WHY] TerminalPane 行数超 §6 上限；卡片是最大块，可自持展开状态，优先独立
// [CHANGE-IMPACT] TerminalPane 的 script 分支改为 <ScriptCard :card="card" />；样式随迁
import { ref } from 'vue'

interface CardData {
  key: string
  phaseClass: string
  desc: string
  timeLabel: string
  stdoutTail: string
  stderrTail: string
  why: string
}

defineProps<{ card: CardData }>()

// 展开状态下沉到卡片内；父组件不再需要 expandedCards 集合
const expanded = ref(false)

function toggle(): void { expanded.value = !expanded.value }
function hasBody(c: CardData): boolean {
  return Boolean(c.stdoutTail || c.stderrTail || c.why)
}
</script>

<template>
  <div class="script-card" :class="card.phaseClass">
    <div
      class="script-card-head"
      :class="{ 'is-clickable': hasBody(card) }"
      :aria-expanded="hasBody(card) ? expanded : undefined"
      @click="hasBody(card) ? toggle() : null"
    >
      <!-- [sc-phase-style-v1] 阶段图标（4 态）；phase 类下沉到 span 以便色选择器命中 -->
      <span class="script-card-phase" :class="card.phaseClass" aria-hidden="true">
        <svg v-if="card.phaseClass === 'phase-done'" class="phase-icon" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M6.5 10.3 L9 12.7 L13.5 7.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <svg v-else-if="card.phaseClass === 'phase-error'" class="phase-icon" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path d="M7 7 L13 13 M13 7 L7 13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <svg v-else-if="card.phaseClass === 'phase-running'" class="phase-icon phase-icon-spin" viewBox="0 0 20 20">
          <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
            <line x1="10" y1="1.5" x2="10" y2="4" opacity="0.25" />
            <line x1="10" y1="16" x2="10" y2="18.5" opacity="0.85" />
            <line x1="1.5" y1="10" x2="4" y2="10" opacity="0.35" />
            <line x1="16" y1="10" x2="18.5" y2="10" opacity="0.7" />
            <line x1="4" y1="4" x2="5.8" y2="5.8" opacity="0.3" />
            <line x1="14.2" y1="14.2" x2="16" y2="16" opacity="0.95" />
            <line x1="16" y1="4" x2="14.2" y2="5.8" opacity="0.5" />
            <line x1="5.8" y1="14.2" x2="4" y2="16" opacity="0.6" />
          </g>
        </svg>
        <svg v-else class="phase-icon" viewBox="0 0 20 20">
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="2 2.5" />
        </svg>
      </span>
      <span class="script-card-desc">{{ card.desc }}</span>
      <span class="script-card-time">{{ card.timeLabel }}</span>
    </div>
    <div v-if="expanded && hasBody(card)" class="script-card-tail">
      <div v-if="card.why" class="why-block">
        <span class="why-label">WHY</span>
        <span class="why-text">{{ card.why }}</span>
      </div>
      <pre v-if="card.stdoutTail" class="tail-pre">{{ card.stdoutTail }}</pre>
      <pre v-if="card.stderrTail" class="tail-pre err">{{ card.stderrTail }}</pre>
    </div>
  </div>
</template>

<style scoped>
.script-card {
  margin: 0;
  padding: 4px 0;
  border: 0;
  background: transparent;
  transition: background-color 0.14s ease;
}
.script-card:hover {
  background: rgba(127, 127, 127, 0.03);
}
.script-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--text-3, #8b949e);
  letter-spacing: 0.2px;
}
.script-card-head.is-clickable {
  cursor: pointer;
  user-select: none;
  margin: -2px -6px;
  padding: 2px 6px;
  border-radius: 6px;
}
.script-card-head.is-clickable:hover {
  background: rgba(127, 127, 127, 0.06);
}
.script-card-head.is-clickable::after {
  content: '▸';
  margin-left: 4px;
  font-size: 9px;
  color: var(--text-3, #8b949e);
  opacity: 0.6;
  transition: transform 0.15s ease;
}
.script-card-head.is-clickable[aria-expanded='true']::after {
  transform: rotate(90deg);
}
.script-card-time {
  margin-left: auto;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 11px;
  font-weight: 400;
  color: var(--text-3, #8b949e);
  opacity: 0.62;
  font-variant-numeric: tabular-nums;
}
.script-card-desc {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-2, #c9d1d9);
  font-size: 12.5px;
  font-weight: 400;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.why-block {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0 8px;
  margin-bottom: 4px;
  border-bottom: 1px dashed var(--border, #30363d);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3, #8b949e);
}
.why-label {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--surface-3, #161b22);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 400;
  letter-spacing: 0.5px;
  color: var(--text-3, #8b949e);
}
.why-text {
  flex: 1 1 auto;
  min-width: 0;
  word-break: break-word;
}
.script-card-tail {
  margin-top: 8px;
  padding: 8px 0 0;
  border-top: 1px dashed var(--border, #30363d);
  max-height: 360px;
  overflow-y: auto;
}
.script-card-tail .tail-pre {
  margin: 0;
  padding: 2px 0;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-2, #c9d1d9);
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
}
.script-card-tail .tail-pre.err {
  color: var(--danger, #ef4444);
}

/* [sc-phase-style-v1] 阶段色与图标；选择器改为 .script-card-phase.phase-*，避免依赖父节点链 */
.script-card-phase {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  color: var(--text-3, #8b949e);
}
.script-card-phase.phase-running {
  color: var(--primary, #58a6ff);
}
.script-card-phase.phase-pending {
  color: var(--warning, #d29922);
}
.script-card-phase.phase-done {
  color: var(--success, #3fb950);
}
.script-card-phase.phase-error {
  color: var(--danger, #f85149);
}
.phase-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  display: block;
}
.phase-icon-spin {
  animation: phase-spin 1.6s linear infinite;
}
@keyframes phase-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
