<script setup lang="ts">
// [no-auto-import-v1] 显式 import：vitest 无 auto-import 插件，须能独立挂载（组件级 E2E 前提）
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { effectiveSessionId } from '../../composables/ui/useAppStorage'
// [task-progress-panel-v1] 任务完成详情面板（替代原进度条）
// [WHY] 原「已完成 N/M 步」只反映脚本卡数量，看不出还剩哪些任务；用户需要任务级视图。
// [CONSTRAINT] 数据源 /__ai/tasks 的 todo(string[]) + done(TaskDoneItem[])；轮询 2s 仅前台。

interface TaskDoneItem { item?: string, at?: number, round?: number }
interface TaskRow { text: string, done: boolean, running: boolean }
// [task-board-items-v1] 结构化任务（服务端 items）；非空即优先于 todo/done 旧视图
interface TaskItemRow { id: string, text: string, status: 'pending' | 'running' | 'done' | 'failed', at: number }
/** 服务端 items 的线上形状（外部数据不可信，逐字段清洗） */
interface RawTaskItem { id?: string, desc?: string, status?: string, doneAt?: number, failedAt?: number }

// [taskboard-poll-seq-v1] 请求序号守卫：慢响应不得覆盖新数据（旧响应到达时丢弃）
let _pollSeq = 0
// [taskboard-ui-v2] 全部完成 3s 后自动折叠为一行摘要
let _autoCollapseTimer: ReturnType<typeof setTimeout> | null = null

const _visible = ref(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)
const todo = ref<string[]>([])
const done = ref<TaskDoneItem[]>([])
// [task-running-v1] 当前正在执行的任务文本
const running = ref('')
const items = ref<TaskItemRow[]>([])
// [taskboard-stale-v1] 连续拉取失败计数：有数据后连续失败 ≥3 次即提示「可能已过期」
// [WHY] 旧实现 if(!ok) return + catch 静默 ⇒ 服务挂掉后面板展示陈旧数据且无任何提示
const failStreak = ref(0)
const collapsed = ref(false)
// [taskboard-ui-v2] 执行中项若不在可视区，滚到中央
const listRef = ref<HTMLElement | null>(null)
const runningItemRef = ref<HTMLElement | null>(null)

// [hmr-safe-poll-v1] useIntervalFn 随组件作用域自动清理，避免 HMR 替换 setup 时旧 timer 残留
// [initial-poll-v1] immediate 只启动定时器、不立即调回调；首次拉取靠 onMounted 手动触发
useIntervalFn(() => { if (_visible.value) void poll() }, 2000)

const rows = computed<TaskRow[]>(() => {
  const runText = String(running.value || '').trim()
  // [task-running-v1] running 项排首位（视觉上「正在做的事」置顶）
  const pend = todo.value.map(t => ({
    text: String(t || '').trim(),
    done: false,
    running: Boolean(runText) && String(t).trim() === runText,
  })).filter(r => r.text)
  const fin = done.value.map(d => ({ text: String(d.item || '').trim(), done: true, running: false })).filter(r => r.text)
  // 重排：running 置顶
  const head = pend.filter(r => r.running)
  const rest = pend.filter(r => !r.running)
  return [...head, ...rest, ...fin]
})
const doneCount = computed(() => {
  if (items.value.length) return items.value.filter(r => r.status === 'done').length
  return done.value.filter(d => String(d.item || '').trim()).length
})
// [task-board-items-v1] 有结构化数据时以 items 为准（旧视图仅作兼容回落）
const total = computed(() => (items.value.length ? items.value.length : rows.value.length))
// [taskboard-ui-v2] 会话 id 就绪性检查：显式读 .value（兼容 vue 真实 ref 与测试的 plain 对象 mock）
const hasSession = computed(() => Boolean(effectiveSessionId.value))
// [taskboard-ui-v2] 进度百分比（视觉进度条）
const progressPercent = computed(() => total.value > 0 ? Math.round((doneCount.value / total.value) * 100) : 0)
// [taskboard-stale-v1] 有数据却连续拉取失败：陈旧提示（无数据时不提示，避免与空态重复）
const stale = computed(() => failStreak.value >= 3 && total.value > 0)
// [taskboard-ui-v2] 三段分组：执行中 / 待办 / 已完成（done 项携带完成时刻）
// [task-board-items-v1] 统一视图：items 优先，缺失时回落 todo/done/running 旧视图
const view = computed(() => {
  if (items.value.length) {
    const run = items.value.find(r => r.status === 'running')
    return {
      running: run ? { text: run.text } : null,
      pending: items.value.filter(r => r.status === 'pending').map(r => ({ text: r.text })),
      failed: items.value.filter(r => r.status === 'failed').map(r => ({ text: r.text, at: r.at })),
      done: items.value.filter(r => r.status === 'done').map(r => ({ text: r.text, at: r.at })),
    }
  }
  const runText = String(running.value || '').trim()
  const legacyRunning = runText ? { text: runText } : null
  const legacyPending = todo.value
    .map(t => String(t || '').trim())
    .filter(t => t && t !== runText)
    .map(t => ({ text: t }))
  const legacyDone = done.value
    .map(d => ({ text: String(d.item || '').trim(), at: Number(d.at) || 0 }))
    .filter(r => r.text)
  return { running: legacyRunning, pending: legacyPending, failed: [] as Array<{ text: string, at: number }>, done: legacyDone }
})
const runningRow = computed(() => view.value.running)
const pendingRows = computed(() => view.value.pending)
const failedRows = computed(() => view.value.failed)
const doneRows = computed(() => view.value.done)
// [task-running-v1] 滚动定位用：执行中项文本（items / 旧视图两条路径统一）
const runningText = computed(() => String(view.value.running?.text || ''))

watch(() => total.value > 0 && doneCount.value === total.value, (allDone) => {
  if (_autoCollapseTimer) { clearTimeout(_autoCollapseTimer); _autoCollapseTimer = null }
  if (allDone) {
    _autoCollapseTimer = setTimeout(() => {
      collapsed.value = true
      _autoCollapseTimer = null
    }, 3000)
  }
})
watch(() => runningText.value, async (v) => {
  if (!v) return
  await nextTick()
  const list = listRef.value
  const item = runningItemRef.value
  if (!list || !item) return
  const lr = list.getBoundingClientRect()
  const ir = item.getBoundingClientRect()
  if (ir.top < lr.top || ir.bottom > lr.bottom) {
    item.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
})

onMounted(() => {
  if (_visible.value) void poll()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
})
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
  if (_autoCollapseTimer) { clearTimeout(_autoCollapseTimer); _autoCollapseTimer = null }
})

// [taskboard-ui-v2] done 项显示 HH:MM 完成时刻
function hhmm(ts: number): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
async function poll() {
  // [taskboard-sid-guard-v1] sid 空即早退：全局桶在多窗口下=别家数据，宁可不显示也不串台
  if (!effectiveSessionId.value) return
  const mySeq = ++_pollSeq
  try {
    const sidQ = `?sid=${encodeURIComponent(effectiveSessionId.value)}`
    // [taskboard-timeout-v1] 5s 超时避免请求悬挂；AbortSignal.timeout 在 node18+/现代浏览器可用
    const r = await fetch(`/__ai/tasks${sidQ}`, {
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) { failStreak.value++; return }
    if (mySeq !== _pollSeq) return
    const j = await r.json()
    if (mySeq !== _pollSeq) return
    todo.value = Array.isArray(j?.todo) ? j.todo.map(String) : []
    done.value = Array.isArray(j?.done) ? j.done : []
    running.value = typeof j?.running === 'string' ? j.running : ''
    // [task-board-items-v1] 结构化任务：状态取自服务端投影（含 running 超时回退后的 pending）
    items.value = Array.isArray(j?.items)
      ? (j.items as RawTaskItem[])
          .filter((x: unknown) => Boolean(x) && typeof x === 'object')
          .map((x: RawTaskItem) => ({
            id: String(x.id || ''),
            text: String(x.desc || '').trim(),
            status: (x.status === 'running' || x.status === 'done' || x.status === 'failed' ? x.status : 'pending') as TaskItemRow['status'],
            at: Number(x.doneAt || x.failedAt) || 0,
          }))
          .filter((x: TaskItemRow) => Boolean(x.text))
      : []
    // [taskboard-stale-v1] 成功即清零：陈旧提示只在「连续失败」后出现，单次抖动不误报
    failStreak.value = 0
  } catch { failStreak.value++ /* [taskboard-stale-v1] 超时/网络错误计入失败连击（旧实现静默） */ }
}
function onVis() {
  if (typeof document === 'undefined') return
  _visible.value = document.visibilityState === 'visible'
  if (_visible.value) void poll()
}
</script>

<template>
  <div v-if="hasSession" class="task-progress" :class="{ collapsed, 'is-empty': total === 0 }">
    <button
      type="button"
      class="tp-head"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span class="tp-caret" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
      <span class="tp-title">任务完成详情</span>
      <span v-if="total > 0" class="tp-pct">{{ progressPercent }}%</span>
      <span class="tp-count">{{ doneCount }}/{{ total }}</span>
    </button>
    <div v-if="stale" class="tp-stale" role="status">
      数据可能已过期（连续 {{ failStreak }} 次拉取失败）
    </div>
    <div v-show="!collapsed && total > 0" class="tp-progress-bar" aria-hidden="true">
      <div class="tp-progress-fill" :style="{ width: `${progressPercent}%` }" />
    </div>
    <div v-show="!collapsed && total > 0" ref="listRef" class="tp-list" role="list">
      <div v-if="runningRow" ref="runningItemRef" class="tp-item running">
        <span class="tp-icon" aria-hidden="true">◐</span>
        <span class="tp-text">{{ runningRow.text }}</span>
      </div>
      <template v-if="pendingRows.length">
        <div v-if="runningRow" class="tp-group-label">
          待办
        </div>
        <div v-for="r in pendingRows" :key="`p-${r.text}`" class="tp-item">
          <span class="tp-icon" aria-hidden="true">○</span>
          <span class="tp-text">{{ r.text }}</span>
        </div>
      </template>
      <template v-if="failedRows.length">
        <div class="tp-group-label">
          失败
        </div>
        <div v-for="r in failedRows" :key="`f-${r.text}`" class="tp-item failed">
          <span class="tp-icon" aria-hidden="true">✗</span>
          <span class="tp-text">{{ r.text }}</span>
          <span v-if="hhmm(r.at)" class="tp-time">{{ hhmm(r.at) }}</span>
        </div>
      </template>
      <template v-if="doneRows.length">
        <div class="tp-group-label">
          已完成
        </div>
        <div v-for="r in doneRows" :key="`d-${r.text}`" class="tp-item done">
          <span class="tp-icon" aria-hidden="true">✓</span>
          <span class="tp-text">{{ r.text }}</span>
          <span v-if="hhmm(r.at)" class="tp-time">{{ hhmm(r.at) }}</span>
        </div>
      </template>
    </div>
    <div v-if="!collapsed && total === 0" class="tp-empty">
      暂无任务
    </div>
  </div>
</template>

<style scoped>
.task-progress {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  max-height: 34vh;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  font-size: 12px;
}
.task-progress.collapsed {
  max-height: none;
}
.tp-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border: 0;
  background: transparent;
  color: var(--text-2);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.tp-head:hover {
  background: rgb(127 127 127 / 6%);
}
.tp-caret {
  width: 10px;
  color: var(--text-3);
}
.tp-title {
  flex: 1;
  font-weight: 600;
}
.tp-count {
  padding: 1px 6px;
  font:
    600 10.5px/1.4 ui-monospace,
    monospace;
  color: var(--primary);
  background: rgb(88 166 255 / 12%);
  border-radius: 999px;
}
.tp-list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 2px 10px 8px;
  list-style: none;
  overflow-y: auto;
}
.tp-item {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 2px 0;
  color: var(--text);
  line-height: 1.45;
}
.tp-item .tp-icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  color: var(--text-3);
}
.tp-item .tp-text {
  flex: 1;
  min-width: 0;
  word-break: break-word;
}
.tp-item.done .tp-text {
  color: var(--text-3);
  text-decoration: line-through;
  text-decoration-thickness: 1px;
}
.tp-item.done .tp-icon {
  color: #22c55e;
}
/* [task-running-v1] 执行中：图标旋转 + 主题色高亮 + 微脉动背景 */
.tp-item.running {
  background: rgb(88 166 255 / 8%);
  border-radius: 4px;
  padding: 2px 6px;
  margin: 0 -6px;
}
.tp-item.running .tp-icon {
  color: var(--primary, #58a6ff);
  animation: tp-spin 1.2s linear infinite;
  display: inline-block;
}
.tp-item.running .tp-text {
  color: var(--primary, #58a6ff);
  font-weight: 600;
}
@keyframes tp-spin {
  to {
    transform: rotate(360deg);
  }
}
/* [taskboard-ui-v2] 百分比徽章：monospace 数字，弱背景 */
.tp-pct {
  padding: 1px 6px;
  font:
    600 10.5px/1.4 ui-monospace,
    monospace;
  color: var(--text-3);
  background: rgb(127 127 127 / 10%);
  border-radius: 999px;
  margin-right: 2px;
}
/* [taskboard-ui-v2] 顶部细进度条 */
.tp-progress-bar {
  height: 3px;
  flex-shrink: 0;
  background: rgb(127 127 127 / 12%);
  overflow: hidden;
}
.tp-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, #58a6ff, #3fb950);
  transition: width 0.3s ease;
}
/* [taskboard-ui-v2] 三段分组标签 */
.tp-group-label {
  padding: 6px 0 2px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--text-3);
  text-transform: uppercase;
}
/* [taskboard-stale-v1] 连续拉取失败提示：黄色弱底，不与错误态混淆 */
.tp-stale {
  padding: 4px 10px;
  font-size: 11px;
  color: #d29922;
  background: rgb(210 153 34 / 10%);
  border-bottom: 1px solid var(--border);
}
/* [task-board-fail-v1] 失败项：✗ + 暗红，不加删除线（与已完成区分） */
.tp-item.failed .tp-icon {
  color: #f85149;
}
.tp-item.failed .tp-text {
  color: var(--text-2);
}
/* [taskboard-ui-v2] 完成时刻（右对齐弱色） */
.tp-item .tp-time {
  flex-shrink: 0;
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* [taskboard-ui-v2] 空态占位 */
.tp-empty {
  padding: 10px 12px;
  font-size: 11.5px;
  color: var(--text-3);
  text-align: center;
}
</style>
