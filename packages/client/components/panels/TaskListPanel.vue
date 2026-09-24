<script setup lang="ts">
import { computed, ref } from 'vue'
import { useTasks } from '../../composables/data/useTasks'
import TaskTree from './TaskTree.vue'
import RoundNarrative from './RoundNarrative.vue'
import TrustGauge from './TrustGauge.vue'

defineOptions({ name: 'TaskListPanel' })

// [panel-tabs-v1] 顶部 tab：plan（默认）/ report
type TabId = 'plan' | 'report'

/** 当前激活的标签页标识 */
const activeTab = ref<TabId>('plan')
const { state, lastError, lastUpdated, stale, staleReason, consecutiveErrors } = useTasks()

// [progress-totals-v1] 优先用 plan.json 的 totals（全局口径），回退 state 的 todo+done
const total = computed(() => {
  const pt = state.value.planTotals
  if (pt && typeof pt.all === 'number' && pt.all > 0) return pt.all
  return state.value.todo.length + state.value.done.length
})
/** 已完成任务列表 */
const completed = computed(() => {
  const pt = state.value.planTotals
  if (pt && typeof pt.done === 'number') return pt.done
  return state.value.done.length
})
/** 百分比（0-100） */
const pct = computed(() => (total.value === 0 ? 0 : Math.round((completed.value * 100) / total.value)))

/** 进行中任务列表 */
const running = computed(() => state.value.status === 'running')
/** 已完成任务列表 */
const done = computed(() => state.value.status === 'done')
/** 受阻任务列表 */
const blocked = computed(() => state.value.status === 'blocked')

/**
 * 执行 fmt Updated
 * @param ms - ms
 */
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
      <button
        v-for="t in [{ id: 'plan', label: '计划' }, { id: 'report', label: '报告' }]"
        :key="t.id"
        class="task-panel-tab"
        :class="{ 'is-active': activeTab === t.id }"
        type="button"
        @click="activeTab = (t.id as TabId)"
      >
        {{ t.label }}
      </button>
      <span class="task-panel-count">
        <span class="task-panel-count-num">{{ completed }}/{{ total }}</span>
        <span class="task-panel-count-bar"><span class="task-panel-count-bar-fill" :style="{ width: `${pct}%` }" /></span>
      </span>
    </div>
    <div class="task-panel-body">
      <!-- <div class="task-panel-meta">
        <span>轮次 {{ state.round }}</span>
        <span class="task-panel-status">{{ state.status }}</span>
      </div> -->
      <!-- [tier2c-2] 降级优雅失败：连续失败或静默超时时展示提示，页面仍显示最后已知状态 -->
      <div v-if="stale" class="task-panel-stale" :title="staleReason">
        <span class="task-panel-stale-icon">⚠</span>
        <span class="task-panel-stale-text">连接异常，展示最后已知状态</span>
        <span v-if="consecutiveErrors" class="task-panel-stale-count">×{{ consecutiveErrors }}</span>
      </div>
      <!-- [panel-tabs-v1] 报告 tab：信任 + 最近动作 -->
      <template v-if="activeTab === 'report'">
        <TrustGauge :trust="state.trust" />
        <RoundNarrative :decisions="state.decisions" />
      </template>
      <!-- [task-tree-mount-v1] -->
      <!-- [plan-tiers-mount-v2] tiers 独立于 todoItems，plan.json 有内容就渲染 -->
      <!-- [task-current-goal-v1] 传入当前 goal 供高亮 -->
      <TaskTree v-if="activeTab === 'plan' && ((state.todoItems && state.todoItems.length) || (state.tiers && state.tiers.length))" :items="state.todoItems || []" :tiers="state.tiers" :current-goal="state.goal || ''" />
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
  height: 100%;
  min-height: 0;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}

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

.task-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 12px;
}

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

@keyframes task-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.75;
  }
}

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

.task-panel-idle {
  padding: 24px 8px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}

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

.task-panel-stale {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  margin-bottom: 8px;
  background: var(--danger-bg, rgba(239, 68, 68, 0.12));
  border-left: 3px solid var(--danger, #ef4444);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-2, #cbd5e1);
  animation: task-stale-blink 2s ease-in-out infinite;
}
.task-panel-stale-icon {
  color: var(--danger, #ef4444);
  flex-shrink: 0;
}
.task-panel-stale-text {
  flex: 1;
}
.task-panel-stale-count {
  font-family: var(--mono, monospace);
  font-size: 10px;
  color: var(--danger, #ef4444);
}
@keyframes task-stale-blink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.72;
  }
}

/* [panel-tabs-v1] 头部 tab */
.task-panel-tab {
  background: transparent;
  border: 0;
  padding: 2px 10px;
  border-radius: 6px;
  color: var(--text-3, #94a3b8);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s;
}
.task-panel-tab:hover {
  color: var(--text-2, #cbd5e1);
  background: var(--surface-2, #252525);
}
.task-panel-tab.is-active {
  color: var(--text, #fff);
  background: var(--surface-3, #2f2f2f);
}

/* [count-bar-v1] 计数内迷你进度条 */
.task-panel-count {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--surface-3);
  font-size: 11px;
  font-family: var(--mono, monospace);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.task-panel-count-num {
  color: var(--text-2, #cbd5e1);
}
.task-panel-count-bar {
  display: inline-block;
  width: 42px;
  height: 4px;
  background: var(--surface-2);
  border-radius: 2px;
  overflow: hidden;
}
.task-panel-count-bar-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--success, #22c55e), var(--primary, #3b82f6));
  border-radius: 2px;
  transition: width 0.3s ease;
}
</style>
