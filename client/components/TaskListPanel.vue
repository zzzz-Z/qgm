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

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
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
  <section class="task-panel" :class="{ done, blocked, running }">
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
/* [fix-task-style-v2] 任务清单样式 */
.task-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}

/* 头部 */
.task-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.task-panel-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
  transition:
    background 0.15s,
    box-shadow 0.15s;
}
.task-panel:not(.done):not(.blocked) .task-panel-dot {
  background: var(--success);
  box-shadow: 0 0 0 3px var(--success-bg);
}
.task-panel.done .task-panel-dot {
  background: var(--text-3);
}
.task-panel.blocked .task-panel-dot {
  background: var(--danger);
  box-shadow: 0 0 0 3px var(--danger-bg);
}
.task-panel-title {
  flex: 1;
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
}
.task-panel-count {
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--surface-3);
}

/* body */
.task-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 12px;
}

/* 进度条 */
.task-panel-bar {
  height: 6px;
  background: var(--surface-3);
  border-radius: 3px;
  overflow: hidden;
  margin-bottom: 8px;
}
.task-panel-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--success), var(--primary));
  border-radius: 3px;
  transition: width 0.3s ease;
}

/* 元信息 */
.task-panel-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: var(--text-3);
  margin-bottom: 10px;
}
.task-panel-status {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 10px;
}

/* 进行中 */
.task-panel-current {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  background: var(--primary-bg);
  border-left: 3px solid var(--primary);
  border-radius: 6px;
  color: var(--text);
  animation: task-pulse 1.8s ease-in-out infinite;
}
.task-panel-current-label {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--surface);
  margin-top: 1px;
}
.task-panel-current-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
@keyframes task-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.75;
  }
}

/* section */
.task-panel-section {
  margin-top: 12px;
}
.task-panel-section:first-child {
  margin-top: 0;
}
.task-panel-section-title {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-3);
  margin-bottom: 6px;
  padding-bottom: 4px;
  border-bottom: 1px dashed var(--border);
}

/* list */
.task-panel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.task-panel-item {
  padding: 5px 8px;
  border-radius: 6px;
  word-break: break-word;
  line-height: 1.4;
  font-size: 12px;
  transition:
    background 0.12s,
    border-color 0.12s;
}

/* 待办项 */
.task-panel-item.pending {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}
.task-panel-item.pending::before {
  content: '';
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  border: 1.5px solid var(--text-3);
  border-radius: 3px;
}
.task-panel-item.pending:hover {
  background: var(--surface-3);
  border-color: var(--border-2);
}

/* 完成项 */
.task-panel-item.finished {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: transparent;
  color: var(--text-3);
  padding: 4px 8px;
}
.task-panel-item.finished::before {
  content: '✓';
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  margin-top: 2px;
  font-size: 11px;
  font-weight: 700;
  color: var(--success);
  line-height: 12px;
  text-align: center;
}
.task-panel-item-time {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--mono, monospace);
  color: var(--text-3);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.task-panel-item-text {
  flex: 1;
  min-width: 0;
}

/* 空态 */
.task-panel-idle {
  padding: 24px 8px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}

/* 底栏 */
.task-panel-foot {
  margin-top: 12px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  font-size: 10px;
  font-family: var(--mono, monospace);
  color: var(--text-3);
  text-align: right;
}
.task-panel-error {
  color: var(--danger);
}
</style>
