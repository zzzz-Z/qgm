<script setup lang="ts">
// [no-auto-import-v1] 显式 import：vitest 无 auto-import 插件，须能独立挂载（组件级 E2E 前提）
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useIntervalFn } from '@vueuse/core'
import { effectiveSessionId } from '../../composables/ui/useAppStorage'
// [taskboard-loop-badge-v1] 循环运行状态徽章：单一真相源 useRuntime（kind: idle/running/waiting/paused/stopped）
import { useRuntime } from '../../composables/ai/useRuntime'
import { LOOP_BADGE } from './loop-badge'
// [task-progress-panel-v1] 任务完成详情面板（替代原进度条）
// [WHY] 原「已完成 N/M 步」只反映脚本卡数量，看不出还剩哪些任务；用户需要任务级视图。
// [CONSTRAINT] 数据源 /__ai/tasks 的 todo(string[]) + done(TaskDoneItem[])；轮询 2s 仅前台。

interface TaskDoneItem { item?: string, at?: number, round?: number }
interface TaskRow { text: string, done: boolean, running: boolean }
// [task-board-items-v1] 结构化任务（服务端 items）；非空即优先于 todo/done 旧视图
interface TaskItemRow { id: string, text: string, status: 'pending' | 'running' | 'done' | 'failed', at: number }
/** 服务端 items 的线上形状（外部数据不可信，逐字段清洗） */
interface RawTaskItem { id?: string, desc?: string, status?: string, startedAt?: number, doneAt?: number, failedAt?: number }

// [taskboard-poll-seq-v1] 请求序号守卫：慢响应不得覆盖新数据（旧响应到达时丢弃）
let _pollSeq = 0
// [taskboard-ui-v2] 全部完成 3s 后自动折叠为一行摘要
let _autoCollapseTimer: ReturnType<typeof setTimeout> | null = null
// [taskboard-hide-delay-v2] 全完成隐藏延迟：原 3s 太快，用户扫一眼未尽就消失；
// 延长到 30s 给足「看完成项划线 + 百分比」的时间。
const AUTO_HIDE_DELAY_MS = 30_000
// [loop-badge-coverage-v1] 与 transitions.ts 的 ACTIVE 对齐（去掉 paused / budget-limited：
//   两者都是「卡住等用户」而非「在推进」，遗留提示条不该说「循环运行中」）
const LOOP_PROGRESSING = new Set(['running', 'preparing', 'waiting', 'parsing', 'executing', 'feedback', 'handoff', 'waiting-input'])

const _visible = ref(typeof document !== 'undefined' ? document.visibilityState === 'visible' : true)
const todo = ref<string[]>([])
const done = ref<TaskDoneItem[]>([])
// [task-running-v1] 当前正在执行的任务文本
const running = ref('')
const items = ref<TaskItemRow[]>([])
// [ui-loading-state-v1] 首轮 poll 是否已回（C4）
const loaded = ref(false)
// [taskboard-stale-v1] 连续拉取失败计数：有数据后连续失败 ≥3 次即提示「可能已过期」
// [WHY] 旧实现 if(!ok) return + catch 静默 ⇒ 服务挂掉后面板展示陈旧数据且无任何提示
const failStreak = ref(0)
const collapsed = ref(false)
// [taskboard-hide-after-done-v1] 全完成 → 3s 后整体隐藏（此前仅折叠）：完成态常驻无信息量，隐藏更干净
// [CONSTRAINT] 隐藏只由 hiddenAfterDone 控制；新任务到达（total 变化 / 非全完成）时 watch 自动恢复
const hiddenAfterDone = ref(false)
// [taskboard-ui-v2] 执行中项若不在可视区，滚到中央
const listRef = ref<HTMLElement | null>(null)
const runningItemRef = ref<HTMLElement | null>(null)
const clearing = ref(false)
// [taskboard-retry-v1] 失败项一键重新登记：push 原文（服务端对 failed 项允许重新登记），下一轮 poll 回 pending
const retrying = ref('')
// [taskboard-group-collapse-v1] 分组可折叠：done 一多就把待办挤出视野，需能单独收起某一组。
// [WHY] 默认收起「已完成」——历史项只增不减，常驻展开会持续挤占待办与失败的可见高度。
const collapsedGroups = ref<Record<string, boolean>>({ done: true })
// [taskboard-elapsed-v1] 当前轮耗时：取运行中任务的 at，运行中每秒刷新；无运行项则不显示（不刷 0s 噪音）
const nowTick = ref(Date.now())

// [taskboard-elapsed-v1] 每秒刷新仅用于耗时显示；用独立守卫判断（不引用后定义的 isLoopActive，
//   避免 ts/no-use-before-define），无运行项时 tick 不推进，elapsedLabel 自然为空。
useIntervalFn(() => { nowTick.value = Date.now() }, 1000)
// [hmr-safe-poll-v1] useIntervalFn 随组件作用域自动清理，避免 HMR 替换 setup 时旧 timer 残留
// [initial-poll-v1] immediate 只启动定时器、不立即调回调；首次拉取靠 onMounted 手动触发
useIntervalFn(() => { if (_visible.value) void poll() }, 2000)
// [taskboard-loop-badge-v1] 循环运行状态徽章：头部常显，让「9 项待办挂着但循环死活未知」一眼可判
const { state: runtimeState } = useRuntime()

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
// [taskboard-clear-v1] 手动清空：仅当无「执行中」任务时显示（防误删进行中的清单）
// [WHY] 循环异常终止（崩溃/硬超时/熔断）不走收尾清空路径，failed/done 残留会一直挂着——用户需要手动出口
// [leftover-clear-fix-v1] 原判据还要求 pendingRows.length === 0，与 hasLeftover 提示互斥：
//   提示条「检测到 N 项未完成任务…点上方『清空』放弃」恰恰在有待办且无执行中时出现，
//   此时 canClear 恒为 false ⇒ 按钮永远不渲染，提示成为死引导。
//   清空的真实风险是有执行中项；待办而无执行中 = 循环未在跑（遗留/已停），清空正是提示自己引导的动作。
const canClear = computed(() => total.value > 0 && !runningRow.value)
// [refresh-leftover-hint-v1] 刷新遗留提示：有待办且无执行中 ⇒ 大概率是刷新前遗留（循环已 stopped）
const hasLeftover = computed(() => pendingRows.value.length > 0 && !runningRow.value)
const loopBadge = computed(() => LOOP_BADGE[String(runtimeState.value.kind)] || LOOP_BADGE.idle)
// [status-unify-v1] 阶段徽章已上提到顶部阶段条；此处仅取文案用于提示句
const loopBadgeText = computed(() => loopBadge.value.text)
// [taskboard-loop-badge-v1] 循环是否在跑（running/waiting）：leftover 文案分叉用（模板对普通对象不自动解包，统一走 computed）
const isLoopActive = computed(() => LOOP_PROGRESSING.has(String(runtimeState.value.kind)))
const elapsedLabel = computed(() => {
  // [taskboard-elapsed-v3] 判据改为「有 running 项」而非 loop kind：任务看板与循环状态解耦，
  //   无头/未启动循环时 kind 恒 idle，原判据会让耗时永远不显示（实测）。
  const runAt = items.value.find(r => r.status === 'running')?.at
  if (!runAt) return ''
  const ms = nowTick.value - runAt
  return ms < 1000 ? '' : `${Math.round(ms / 1000)}s`
})
// [taskboard-failed-badge-v1] 头部失败计数徽章：不展开也能一眼看到有失败项
const failedCount = computed(() => failedRows.value.length)

watch(() => total.value > 0 && doneCount.value === total.value, (allDone) => {
  if (_autoCollapseTimer) { clearTimeout(_autoCollapseTimer); _autoCollapseTimer = null }
  if (allDone) {
    _autoCollapseTimer = setTimeout(() => {
      collapsed.value = true
      hiddenAfterDone.value = true
      _autoCollapseTimer = null
    }, AUTO_HIDE_DELAY_MS)
  } else {
    hiddenAfterDone.value = false
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
// [taskboard-sid-change-v1] sid 变化（切换会话 / 从 fallback 切到真值）立即刷新，
//   不必等 2s 轮询周期；也是「面板状态长时间不更新」的第一道修复
watch(effectiveSessionId, () => { if (_visible.value) void poll() })

onMounted(() => {
  if (_visible.value) void poll()
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVis)
})
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVis)
  if (_autoCollapseTimer) { clearTimeout(_autoCollapseTimer); _autoCollapseTimer = null }
})

// [loop-badge-coverage-v1] LoopState 共 13 态，原表只映射 5 态 ⇒ 其余 8 态全部回落到 idle「未运行」。
//   实测最刺眼的两条：脚本真的在跑（executing）和会话轮转中（handoff）都显示「未运行」。

function toggleGroup(name: string): void {
  collapsedGroups.value = { ...collapsedGroups.value, [name]: !collapsedGroups.value[name] }
}
// [failed-round-highlight-v1] 顶栏跳转：找 DOM 里最后一张 .script-card.phase-error 并滚到视野内。
// [CONSTRAINT] 卡片 id 由 ScriptCard 按 card.key 生成（card-<key>），此处只按类名找，避免跨组件传 key。
function jumpToLatestFailed() {
  if (typeof document === 'undefined') return
  const nodes = document.querySelectorAll('.script-card.phase-error')
  const last = nodes[nodes.length - 1]
  if (last) last.scrollIntoView({ behavior: 'smooth', block: 'center' })
}
async function clearBoard(): Promise<void> {
  const sid = effectiveSessionId.value
  if (!sid || clearing.value) return
  clearing.value = true
  try {
    // set 空清单 ⇒ 服务端 tasks-by-sid-empty-v1 删桶
    const r = await fetch('/__ai/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'set', sid, todo: [], done: [] }),
    })
    if (r.ok) {
      items.value = []
      todo.value = []
      done.value = []
      await poll()
    } else {
      failStreak.value++
    }
  } catch {
    failStreak.value++
  } finally {
    clearing.value = false
  }
}
async function retryTask(text: string): Promise<void> {
  const sid = effectiveSessionId.value
  if (!sid || !text || retrying.value) return
  retrying.value = text
  try {
    const r = await fetch('/__ai/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'push', sid, pushTodo: [text] }),
    })
    if (r.ok) await poll()
    else failStreak.value++
  } catch {
    failStreak.value++
  } finally {
    retrying.value = ''
  }
}
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
            // [taskboard-elapsed-v2] running 项取 startedAt（原只读 doneAt/failedAt，
            //   ⇒ 运行中 at 恒为 0，耗时永远算不出）；done/failed 仍按各自时刻
            at: Number(x.startedAt || x.doneAt || x.failedAt) || 0,
          }))
          .filter((x: TaskItemRow) => Boolean(x.text))
      : []
    // [taskboard-stale-v1] 成功即清零：陈旧提示只在「连续失败」后出现，单次抖动不误报
    failStreak.value = 0
    loaded.value = true
  } catch { failStreak.value++ /* [taskboard-stale-v1] 超时/网络错误计入失败连击（旧实现静默） */ }
}
function onVis() {
  if (typeof document === 'undefined') return
  _visible.value = document.visibilityState === 'visible'
  if (_visible.value) void poll()
}
</script>

<template>
  <!-- [taskboard-hide-when-empty-v1] 无任务时隐藏；v-show 保持挂载以持续轮询（v-if 会停轮询） -->
  <div v-if="hasSession" v-show="total > 0 && !hiddenAfterDone" class="task-progress" :class="{ collapsed, 'is-empty': total === 0 }">
    <button
      type="button"
      class="tp-head"
      :aria-expanded="!collapsed"
      @click="collapsed = !collapsed"
    >
      <span class="tp-caret" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
      <span class="tp-title">任务完成详情</span>
      <!-- [failed-round-highlight-v1] 失败徽标可点：直接滚到时间线里最近一张失败卡 -->
      <button
        v-if="failedCount > 0"
        class="tp-failed-badge is-btn"
        type="button"
        title="跳到最近一次失败"
        @click.stop="jumpToLatestFailed"
      >
        {{ failedCount }} 失败
      </button>
      <span v-if="total > 0" class="tp-pct">{{ progressPercent }}%</span>
      <span class="tp-count">{{ doneCount }}/{{ total }}</span>
      <button
        v-if="canClear"
        type="button"
        class="tp-clear"
        :disabled="clearing"
        aria-label="清空任务看板"
        @click.stop="clearBoard()"
      >
        {{ clearing ? '…' : '清空' }}
      </button>
    </button>
    <!-- [refresh-leftover-hint-v1] 遗留任务提示：不自动续跑，等用户发送提问；
         [leftover-clear-fix-v1] 文案按循环实际状态分叉（原文案在循环已死时仍说「将继续处理」） -->
    <!-- [loop-badge-coverage-v1] 循环状态徽章：13 态各有专属文案，非 idle 态不得回落「未运行」 -->

    <div v-if="hasLeftover" class="tp-leftover" role="status">
      <template v-if="isLoopActive">
        检测到 {{ pendingRows.length }} 项未完成任务 · 循环运行中，发送提问后将继续处理（或点上方「清空」放弃）
      </template>
      <template v-else>
        检测到 {{ pendingRows.length }} 项未完成任务 · 循环{{ loopBadgeText }}，发送提问后将继续处理（或点上方「清空」放弃）
      </template>
    </div>
    <!-- [ui-loading-state-v1] 首轮 poll 未回：骨架提示（WO-20261007-02 阶段 C4） -->
    <div v-if="!loaded" class="tp-loading" role="status">
      加载任务看板…
    </div>
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
        <!-- [taskboard-elapsed-v2] 耗时贴着正在执行的那一行：它属于「当前这件事」而非整个面板 -->
        <span v-if="elapsedLabel" class="tp-item-elapsed">{{ elapsedLabel }}</span>
      </div>
      <template v-if="pendingRows.length">
        <button v-if="runningRow" type="button" class="tp-group-label is-btn" @click="toggleGroup('pending')">
          {{ collapsedGroups.pending ? '▸' : '▾' }} 待办 · {{ pendingRows.length }}
        </button>
        <div v-for="r in (collapsedGroups.pending ? [] : pendingRows)" :key="`p-${r.text}`" class="tp-item">
          <span class="tp-icon" aria-hidden="true">○</span>
          <span class="tp-text">{{ r.text }}</span>
        </div>
      </template>
      <template v-if="failedRows.length">
        <button type="button" class="tp-group-label is-btn" @click="toggleGroup('failed')">
          {{ collapsedGroups.failed ? '▸' : '▾' }} 失败 · {{ failedRows.length }}
        </button>
        <div v-for="r in (collapsedGroups.failed ? [] : failedRows)" :key="`f-${r.text}`" class="tp-item failed">
          <span class="tp-icon" aria-hidden="true">✗</span>
          <span class="tp-text">{{ r.text }}</span>
          <span v-if="hhmm(r.at)" class="tp-time">{{ hhmm(r.at) }}</span>
          <!-- [taskboard-retry-v1] hover 显现：重新登记为待办 -->
          <button
            type="button"
            class="tp-retry"
            :disabled="retrying === r.text"
            aria-label="重新登记该任务"
            @click.stop="retryTask(r.text)"
          >
            {{ retrying === r.text ? '…' : '↻ 重试' }}
          </button>
        </div>
      </template>
      <template v-if="doneRows.length">
        <button type="button" class="tp-group-label is-btn" @click="toggleGroup('done')">
          {{ collapsedGroups.done ? '▸' : '▾' }} 已完成 · {{ doneRows.length }}
        </button>
        <div v-for="r in (collapsedGroups.done ? [] : doneRows)" :key="`d-${r.text}`" class="tp-item done">
          <span class="tp-icon" aria-hidden="true">✓</span>
          <span class="tp-text">{{ r.text }}</span>
          <span v-if="hhmm(r.at)" class="tp-time">{{ hhmm(r.at) }}</span>
        </div>
      </template>
    </div>
    <div v-if="!collapsed && total === 0" class="tp-empty">
      暂无任务 · 复杂任务会自动登记到看板
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
  /* [taskboard-width-fit-v1] 宽度按内容自适应（最长项决定），不撑满父容器；
     max-width 防超长项溢出屏幕，超出时文字换行（tp-text 已设 break-word） */
  /* [taskboard-width-v2] 由 fit-content 改为撑满父容器：
     原窄条会让长任务文本折成 2–3 行，且与右侧对话区宽度严重失配（用户截图反馈）。
     max-width 保留 100% 防溢出，靠内边距控制可读宽度而不是靠缩窄面板。 */
  width: 100%;
  max-width: 100%;
  align-self: stretch;
  /* [taskboard-surface-v2] 加下边框阴影：原纯平面板与下方时间线同底色，
     失败卡红底直接贴上来时看不出边界（用户截图反馈）。 */
  box-shadow:
    0 1px 0 var(--border),
    0 4px 12px -8px rgb(0 0 0 / 45%);
  border-radius: 0 0 8px 8px;
}
.task-progress.collapsed {
  max-height: none;
}
/* [ui-codex-align-v1] 4px 网格：gap 6→8、padding 6/10→8/12 */
.tp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
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
  padding: 2px 8px;
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
  padding: 4px 12px 8px;
  list-style: none;
  overflow-y: auto;
}
.tp-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 0;
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
  /* [ui-color-token-v1] 裸色值 → 语义变量 */
  color: var(--success);
}
/* [task-running-v1] 执行中：图标旋转 + 主题色高亮 + 微脉动背景 */
.tp-item.running {
  background: rgb(88 166 255 / 8%);
  border-radius: 4px;
  padding: 4px 8px;
  margin: 0 -8px;
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
/* [taskboard-head-hierarchy-v1] 进度为主：百分比加粗提亮，计数退为次信息；
   原两者同权重并排，读起来像一坨数字（用户截图反馈）。 */
.tp-pct {
  font-weight: 700;
  color: var(--text-2);
}
.tp-count {
  color: var(--text-3);
  background: rgb(127 127 127 / 8%);
}
/* [taskboard-ui-v2] 百分比徽章：monospace 数字，弱背景 */
.tp-pct {
  padding: 2px 8px;
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
/* [ui-codex-align-v1] 去渐变：进度条用单一强调色（Codex 式「蓝色只给焦点」） */
.tp-progress-fill {
  height: 100%;
  background: var(--primary, #58a6ff);
  transition: width 0.3s ease;
}
/* [taskboard-ui-v2] 三段分组标签 */
.tp-group-label {
  padding: 8px 0 4px;
  /* [ui-type-scale-v1] 辅助下限 11px（原 10px） */
  font-size: var(--font-11);
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--text-3);
  text-transform: uppercase;
}
/* [taskboard-group-collapse-v1] 分组标题按钮化：保留原小标签视觉，但整行可点折叠 */
.tp-group-label.is-btn {
  display: block;
  width: 100%;
  border: 0;
  background: transparent;
  font: inherit;
  font-size: var(--font-11);
  font-weight: 600;
  letter-spacing: 0.6px;
  color: var(--text-3);
  text-align: left;
  cursor: pointer;
  text-transform: uppercase;
}
.tp-group-label.is-btn:hover {
  color: var(--text-2);
}
/* [taskboard-stale-v1] 连续拉取失败提示：黄色弱底，不与错误态混淆 */
/* [ui-loading-state-v1] 首轮 poll 骨架提示（C4） */
.tp-loading {
  padding: 8px 12px;
  font-size: var(--font-11);
  color: var(--text-3);
}
.tp-stale {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--warning);
  background: rgb(210 153 34 / 10%);
  border-bottom: 1px solid var(--border);
}
.tp-leftover {
  padding: 4px 12px;
  font-size: 11px;
  color: var(--primary, #58a6ff);
  background: rgb(88 166 255 / 10%);
  border-bottom: 1px solid var(--border);
}
/* [task-board-fail-v1] 失败项：✗ + 暗红，不加删除线（与已完成区分） */
.tp-item.failed .tp-icon {
  color: var(--danger);
}
.tp-item.failed .tp-text {
  color: var(--text-2);
}
/* [taskboard-ui-v2] 完成时刻（右对齐弱色） */
.tp-item .tp-time {
  flex-shrink: 0;
  margin-left: 6px;
  /* [ui-type-scale-v1] 辅助下限 11px（原 10.5px） */
  font-size: var(--font-11);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* [taskboard-ui-v2] 空态占位 */
.tp-empty {
  padding: 8px 12px;
  font-size: 11.5px;
  color: var(--text-3);
  text-align: center;
}
/* [taskboard-failed-badge-v1] 头部失败计数：暗红徽章，不展开也能看到失败 */
.tp-failed-badge {
  padding: 2px 8px;
  font:
    600 10.5px/1.4 ui-monospace,
    monospace;
  color: var(--danger);
  background: rgb(248 81 73 / 12%);
  border-radius: 999px;
}
/* [failed-round-highlight-v1] 徽章按钮化：清掉原生 button 外观，保留徽章视觉 */
.tp-failed-badge.is-btn {
  border: 0;
  cursor: pointer;
  font-family: inherit;
}
.tp-failed-badge.is-btn:hover {
  background: rgb(248 81 73 / 22%);
}
/* [taskboard-clear-v1] 清空按钮：ghost 风格，hover 加深；仅收尾态出现 */
.tp-clear {
  padding: 1px 8px;
  font: inherit;
  /* [ui-type-scale-v1] 辅助下限 11px（原 10.5px） */
  font-size: var(--font-11);
  color: var(--text-3);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
}
.tp-clear:hover:not(:disabled) {
  color: var(--text);
  background: rgb(127 127 127 / 10%);
}
.tp-clear:disabled {
  opacity: 0.5;
  cursor: default;
}
/* [taskboard-retry-v1] 失败行 hover 显现重试按钮（触屏恒显） */
.tp-retry {
  flex-shrink: 0;
  padding: 0 6px;
  font: inherit;
  /* [ui-type-scale-v1] 辅助下限 11px（原 10.5px） */
  font-size: var(--font-11);
  color: var(--text-2);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.tp-item.failed:hover .tp-retry,
.tp-retry:focus-visible {
  opacity: 1;
}
@media (hover: none) {
  .tp-retry {
    opacity: 1;
  }
}
.tp-retry:hover:not(:disabled) {
  color: var(--primary, #58a6ff);
  border-color: var(--primary, #58a6ff);
}
.tp-retry:disabled {
  opacity: 0.5;
  cursor: default;
}
/* [taskboard-elapsed-v2] 运行中行的耗时：贴在任务文字右侧，弱色不抢主体 */
.tp-item-elapsed {
  flex: 0 0 auto;
  margin-left: auto;
  font: 400 11px/1.4 var(--mono, ui-monospace, monospace);
  color: var(--text-3, #8b949e);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}
</style>
