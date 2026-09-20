<script setup lang="ts">
import { computed } from 'vue'
import { useTasks } from '../composables/useTasks'

defineOptions({ name: 'TaskListPanel' })

const { state, lastError, lastUpdated } = useTasks()

const total = computed(() => state.value.todo.length + state.value.done.length)
const completed = computed(() => state.value.done.length)
const pct = computed(() => (total.value === 0 ? 0 : Math.round((completed.value * 100) / total.value)))
const current = computed(() => state.value.todo[0] || '')
const running = computed(() => state.value.status === 'running')
const done = computed(() => state.value.status === 'done')
const blocked = computed(() => state.value.status === 'blocked')

function pad(n: number): string { return String(n).padStart(2, '0') }
function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function fmtUpdated(ms: number): string {
  if (!ms) return ''
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 3) return '刚刚'
  if (sec < 60) return `${sec}s 前`
  return `${Math.floor(sec / 60)}m 前`
}
</script>

<template>
  <section class="task-panel">
    <div class="task-panel-head">
      <span class="task-panel-dot" />
      <span class="task-panel-title">任务清单</span>
      <span class="task-panel-count">{{ completed }}/{{ total }}</span>
    </div>
    <div class="task-panel-body">
      <div class="task-panel-bar">
        <div class="task-panel-bar-fill" :style="{ width: `${pct}%` }" />
      </div>
      <div class="task-panel-meta">
        <span>轮次 {{ state.round }}</span>
        <span class="task-panel-status">{{ state.status }}</span>
      </div>
      <div v-if="running && current" class="task-panel-current">
        <span class="task-panel-current-label">进行中</span>
        <span class="task-panel-current-text">{{ current }}</span>
      </div>
      <div v-if="state.todo.length > 0" class="task-panel-section">
        <div class="task-panel-section-title">
          待办 {{ state.todo.length }}
        </div>
        <ul class="task-panel-list">
          <li v-for="(t, i) in state.todo" :key="`todo-${i}`" class="task-panel-item pending">
            {{ t }}
          </li>
        </ul>
      </div>
      <div v-if="state.done.length > 0" class="task-panel-section">
        <div class="task-panel-section-title">
          已完成 {{ state.done.length }}
        </div>
        <ul class="task-panel-list">
          <li v-for="(d, i) in state.done.slice(-12).reverse()" :key="`done-${i}`" class="task-panel-item finished">
            <span class="task-panel-item-time">{{ fmtTime(d.at) }}</span>
            <span class="task-panel-item-text">{{ d.item }}</span>
          </li>
        </ul>
      </div>
      <div v-if="total === 0" class="task-panel-idle">
        暂无任务
      </div>
      <div class="task-panel-foot">
        <span v-if="lastError" class="task-panel-error">{{ lastError }}</span>
        <span v-else class="task-panel-updated">{{ fmtUpdated(lastUpdated) }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
.task-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  font-size: 12px;
  color: inherit;
  height: 100%;
}
.task-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
  border-bottom: 1px solid var(--border, #ddd);
}
.task-panel-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: #888;
  flex-shrink: 0;
}
.task-panel:not(.done):not(.blocked) .task-panel-dot {
  background: #22c55e;
}
.task-panel.done .task-panel-dot {
  background: #64748b;
}
.task-panel.blocked .task-panel-dot {
  background: #ef4444;
}
.task-panel-title {
  flex: 1;
  font-weight: 600;
}
.task-panel-count {
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
.task-panel-body {
  padding: 8px 10px;
  overflow-y: auto;
  max-height: calc(100vh - 200px);
}
.task-panel-bar {
  height: 4px;
  background: rgba(128, 128, 128, 0.15);
  border-radius: var(--radius-2);
  overflow: hidden;
}
.task-panel-bar-fill {
  height: 100%;
  background: #22c55e;
  transition: width 0.3s ease;
}
.task-panel-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  opacity: 0.7;
}
.task-panel-status {
  text-transform: lowercase;
}
.task-panel-current {
  margin-top: 8px;
  padding: 6px 8px;
  border-left: 3px solid #22c55e;
  background: rgba(34, 197, 94, 0.08);
  border-radius: var(--radius-4);
}
.task-panel-current-label {
  display: block;
  font-size: 10px;
  opacity: 0.6;
  margin-bottom: 2px;
}
.task-panel-current-text {
  word-break: break-all;
}
.task-panel-section {
  margin-top: 10px;
}
.task-panel-section-title {
  font-size: 10px;
  opacity: 0.5;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
}
.task-panel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.task-panel-item {
  padding: 3px 6px;
  border-radius: var(--radius-4);
  word-break: break-all;
  line-height: 1.35;
}
.task-panel-item.pending {
  background: rgba(128, 128, 128, 0.08);
}
.task-panel-item.finished {
  display: flex;
  gap: 6px;
  background: rgba(100, 116, 139, 0.08);
  opacity: 0.75;
}
.task-panel-item-time {
  flex-shrink: 0;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}
.task-panel-item-text {
  flex: 1;
}
.task-panel-idle {
  margin-top: 8px;
  text-align: center;
  opacity: 0.5;
  padding: 8px;
}
.task-panel-foot {
  margin-top: 8px;
  padding-top: 6px;
  border-top: 1px dashed var(--border, #ddd);
  font-size: 10px;
  opacity: 0.5;
  text-align: right;
}
.task-panel-error {
  color: #ef4444;
  opacity: 1;
}
</style>
