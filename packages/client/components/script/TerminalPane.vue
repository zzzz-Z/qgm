<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useIntervalFn } from '@vueuse/core'
// PLAN 5.2 第四层：原始输出折叠
// 复用项目已有极简 markdown 渲染器（不引入新依赖）
import { renderMarkdown } from '../../composables/useMarkdown.js'
// 事件流单例（localStorage 持久化），用于渲染每轮脚本 desc
import { useEventBus } from '../../composables/ui/useEventStream'
// [rd-import-v1] 引入抽出的轮次分隔条组件
import RoundDivider from './RoundDivider.vue'
// [sc-wire-v1] 脚本卡片抽为子组件
import ScriptCard from './ScriptCard.vue'

interface ScriptItem {
  type: 'script'
  key: string
  langLabel: string
  phaseLabel: string
  phaseClass: string
  // desc 从 body 前移到 header，与 phase / time 同行展示
  desc: string
  timeLabel: string
  stdoutTail: string
  stderrTail: string
  // why 从卡片主体迁移至展开区，避免每张卡都占两行；空串表示无 why
  why: string
}
interface TextItem {
  type: 'text'
  key: string
  timeLabel: string
  html: string
}
interface DoneItem {
  type: 'done'
  key: string
  timeLabel: string
  html: string
}
// 用户提问/回答卡：ScriptPanel.runSmart 与 App.vue ask 回答分支 emit('ai:ask')
// role='user-answer' 时展示为「回答」+ answer-badge，区分于「提问」
interface AskItem { type: 'ask', key: string, timeLabel: string, html: string, role?: 'user-answer' }
// [round-divider-v1] 轮次分隔条：loopRound 变化时插入，视觉上呈现 TRAE 式「轮次分组」
// [CONSTRAINT] 依赖 payload.loopRound（由 App.vue ...currentLoopContext() 注入）；手动模式无 loopRound → 不插条
interface DividerItem { type: 'round-divider', key: string, roundLabel: string, timeLabel: string }

/** 组件接收的 props 定义 */
const props = defineProps<{

  running: boolean
  twStdout: string
  twStderr: string
  twLines: string[]
  twErrLines: string[]
  doneSummary?: string // lineClass: (line: string) => string
  // 等待 AI 回复中；由 ScriptPanel 透传 useAiWaiting().waiting
  aiWaiting?: boolean
}>()
/** 派发 */
// 去掉变量赋值：模板未消费此 emit，赋值触发 unused-imports warning
defineEmits<{ (e: 'applyTemplate', code: string): void }>()

/** 阶段中文标签表；未命中回退为原值 */
const PHASE_LABEL: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
}

// 等待时长本地计时：aiWaiting 为 true 时启动，false 时停止并归零
// [WHY] 用本地 interval 而非改 useAiWaiting 契约（避免污染其他消费方）；仅用于展示层
// [CONSTRAINT] useIntervalFn 组件卸载自动清理；watch 双向同步启停
// [CHANGE-IMPACT] 与 wait-banner 模板成对；去掉 watch 会让秒数永远为 0
const waitElapsed = ref(0)
// [sc-deadcode-v1] expandedCards/toggleCard/isCardExpanded 已下沉到 ScriptCard.vue

/** 列表 */
const chatListRef = ref<HTMLElement | null>(null)

const { events: busEvents } = useEventBus()
const { pause: pauseWaitTimer, resume: resumeWaitTimer } = useIntervalFn(() => {
  waitElapsed.value += 1
}, 1000, { immediate: false })

/**
 * 每轮脚本卡片：从 busEvents 提取 run:start 事件（desc/why/lang/phase）
 * [WHY] 事件流 updateKey 原地更新，同一脚本多次 phase 变化只留一条；desc 用 renderMarkdown 呈现
 * [CONSTRAINT] 仅收 payload.desc 或 summary 非空的事件；无内容的不渲染，避免空卡
 * [CHANGE-IMPACT] 依赖 App.vue / useRunner 的 emit 契约（run:start + payload.desc/why/lang/phase）
 */
const timelineItems = computed(() => {
  const out: Array<ScriptItem | TextItem | DoneItem | AskItem | DividerItem> = []
  // [round-divider-v1] 追踪上一张脚本卡的轮次；跨轮时插入分隔条（初始 0 表示尚未出现任何轮次）
  let lastRound = 0
  for (const ev of busEvents.value) {
    // 用户提问卡：ScriptPanel.runSmart 成功 copyAndFill 后 emit('ai:ask')
    // [CONSTRAINT] 只收 payload.text 非空事件，避免空卡；与 ai:done 同结构仅 badge 不同
    if (ev.kind === 'ai:ask') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      const d0 = new Date(ev.ts || Date.now())
      const pad0 = (n: number) => String(n).padStart(2, '0')
      const timeLabel0 = `${pad0(d0.getHours())}:${pad0(d0.getMinutes())}:${pad0(d0.getSeconds())}`
      // role 分流：'user-answer' 走回答卡样式；缺省按提问卡
      out.push({
        type: 'ask',
        key: `ask-${ev.id}`,
        timeLabel: timeLabel0,
        html: renderMarkdown(text),
        ...(tp.role === 'user-answer' ? { role: 'user-answer' as const } : {}),
      })
      continue
    }
    // 总结卡片：来自 ai:done 事件（方案 A，持久化）
    // [CONSTRAINT] text 为空表示纯占位（AI 只回复 DONE 无总结），跳过不渲染

    if (ev.kind === 'ai:done') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      const d0 = new Date(ev.ts || Date.now())
      const pad0 = (n: number) => String(n).padStart(2, '0')
      const timeLabel0 = `${pad0(d0.getHours())}:${pad0(d0.getMinutes())}:${pad0(d0.getSeconds())}`
      out.push({
        type: 'done',
        key: `done-${ev.id}`,
        timeLabel: timeLabel0,
        html: renderMarkdown(text),
      })
      continue
    }
    // 非 cjs 文本（ai:plain / ai:multi）按时间顺序混排为 Markdown 卡片
    // [CONSTRAINT] 只收 payload.text 非空的事件
    if (ev.kind === 'ai:plain' || ev.kind === 'ai:multi') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      const d0 = new Date(ev.ts || Date.now())
      const pad0 = (n: number) => String(n).padStart(2, '0')
      const timeLabel0 = `${pad0(d0.getHours())}:${pad0(d0.getMinutes())}:${pad0(d0.getSeconds())}`
      out.push({
        type: 'text',
        key: `text-${ev.id}`,
        timeLabel: timeLabel0,
        html: renderMarkdown(text),
      })
      continue
    }
    if (ev.kind !== 'run:start') continue
    const p = (ev.payload || {}) as Record<string, unknown>
    const desc = String(p.desc || '').trim()
    const why = String(p.why || '').trim()
    const lang = String(p.lang || 'js')
    const phase = String(p.phase || 'running')
    const key = String(p.updateKey || `ev-${ev.id}`)
    // 跳过旧事件（payload 无 why 且 desc 为默认值）产生的空卡
    if (!why && (!desc || desc === '执行脚本')) continue
    // 提取打字机 tail：useRunner.emitStep 每次节流（250ms）携带
    const stdoutTail = String(p.stdoutTail || '')
    const stderrTail = String(p.stderrTail || '')
    // desc 不再走 body markdown；直接作为 header 文本字段
    const langLabel = lang === 'bash' ? 'BASH' : lang === 'cjs' ? 'CJS' : 'JS'
    // 时间戳：HH:MM:SS，本地时区；ev.ts 为事件更新时刻（updateKey 命中时刷新）
    const d = new Date(ev.ts || Date.now())
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeLabel = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    // [round-divider-v1] loopRound 变化时插一条轮次分隔（不改变原有卡片结构，纯视觉分组）
    const loopRoundNum = Number(p.loopRound || 0)
    if (loopRoundNum > 0 && loopRoundNum !== lastRound) {
      lastRound = loopRoundNum
      out.push({ type: 'round-divider', key: `rd-${loopRoundNum}-${ev.id}`, roundLabel: `R${loopRoundNum}`, timeLabel })
    }
    out.push({ type: 'script', key, langLabel, phaseLabel: PHASE_LABEL[phase] || phase, phaseClass: `phase-${phase}`, desc, timeLabel, stdoutTail, stderrTail, why })
  }

  return out
})
// 折叠展开的卡片 key 集合；用 Set 替换触发响应
// [script-progress-v1] 任务进度：done+error 计完成；TRAE 面板 "X/Y tasks completed" 同语义
// [WHY] 用事件流里的 run:start 卡片计数复用同语义，无需引入额外状态
// [CONSTRAINT] 只统计当前 timelineItems 中的脚本卡；随清屏 / 刷新同步更新
// [CHANGE-IMPACT] 与模板 .progress-header 成对；去掉会让顶部进度消失
const scriptProgress = computed(() => {
  const items = timelineItems.value.filter(c => c.type === 'script') as Array<{ phaseClass: string }>
  let done = 0
  for (const c of items) {
    if (c.phaseClass === 'phase-done' || c.phaseClass === 'phase-error') done += 1
  }
  return { done, total: items.length }
})

watch(() => props.aiWaiting, (v) => {
  if (v) { waitElapsed.value = 0; resumeWaitTimer() }
  else { pauseWaitTimer(); waitElapsed.value = 0 }
}, { immediate: true })
// 总结写入后自动滚到底部，确保用户第一眼看到
// [CONSTRAINT] 需 nextTick 等 DOM 更新完成后再滚；仅当有新内容时触发（props.doneSummary 从空→非空 或 变内容）
// [CHANGE-IMPACT] 若父组件清空 doneSummary（新一轮开始）不滚动；避免滚动位置抖动
watch(
  () => [props.doneSummary, timelineItems.value.length] as const,
  async ([v]) => {
    if (!v && timelineItems.value.length === 0) return
    await nextTick()
    const el = chatListRef.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

// 页面刷新时自动滚到最后一条：
// [WHY] 上面的 watch 非 immediate，刷新时 busEvents 若同步恢复则不触发；需挂载后主动滚一次
// [CONSTRAINT] rAF 二次滚动兜底字体/异步渲染造成的高度变化；一次性，不持续 watch
// [CHANGE-IMPACT] 与上面的 watch 互补：watch 管运行时新增，onMounted 管首次挂载
onMounted(async () => {
  await nextTick()
  // 连续 3 帧滚动：兜底字体/异步渲染/图片导致的高度变化
  for (let i = 0; i < 3; i++) {
    requestAnimationFrame(() => {
      const el = chatListRef.value
      if (el) el.scrollTop = el.scrollHeight
    })
  }
})

/**
 * 响应 Chat Scroll
 */
function onChatScroll(): void { /* 由父组件按需注入滚动处理 */ }
</script>

<template>
  <section class="terminal">
    <!-- [flow-timeline] 全流程时间线 -->
    <div class="flow-timeline">
      <!-- [script-progress-v1] 顶部进度条：X/Y tasks completed；无脚本卡时不渲染 -->
      <div v-if="scriptProgress.total > 0" class="progress-header">
        <span class="progress-dot" :class="{ 'is-active': scriptProgress.done < scriptProgress.total }" />
        <span class="progress-text">
          {{ scriptProgress.done }}/{{ scriptProgress.total }} tasks completed
        </span>
        <span class="progress-bar">
          <span
            class="progress-bar-fill"
            :style="{ width: `${scriptProgress.total ? (scriptProgress.done / scriptProgress.total * 100) : 0}%` }"
          />
        </span>
      </div>
      <div ref="chatListRef" class="chat-list" @scroll="onChatScroll">
        <!-- 每轮脚本 desc：Markdown 渲染；来源 busEvents（已持久化到 localStorage） -->
        <template v-for="card in timelineItems" :key="card.key">
          <!-- [rd-tpl-v1] 已抽为子组件 -->
          <RoundDivider
            v-if="card.type === 'round-divider'"
            :round-label="card.roundLabel"
            :time-label="card.timeLabel"
          />
          <ScriptCard
            v-else-if="card.type === 'script'"
            :key="card.key"
            :card="card"
          />
          <section v-else-if="card.type === 'done'" class="done-summary">
            <div class="done-summary-head">
              任务完成 · 总结
            </div>
            <div class="done-summary-body" v-html="card.html" />
          </section>
          <!-- 非 cjs 文本卡片：与总结同排版 -->
          <section v-else-if="card.type === 'text'" class="text-card">
            <header class="text-card-head">
              <span class="text-card-badge">AI</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="card.html" />
          </section>
          <!-- 用户提问/回答卡：badge 用「你」区分 AI；回答额外走 answer-card 视觉 -->
          <section v-else-if="card.type === 'ask'" class="text-card" :class="card.role === 'user-answer' ? 'answer-card' : 'ask-card'">
            <header class="text-card-head">
              <span class="text-card-badge" :class="card.role === 'user-answer' ? 'answer-badge' : 'ask-badge'">你</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="card.html" />
          </section>
        </template>

        <!-- 空态：无卡片 / 无输出 / 无总结 -->
        <div v-if="!running && !twStdout && !twStderr && timelineItems.length === 0" class="tree-empty">
          <div class="empty-title">
            还没有执行记录
          </div>
          <div class="empty-sub">
            点击「运行」开始自动化循环
          </div>
        </div>
      </div>
      <!-- 等待 AI 回复指示条：收到首 token / reply 后由 stopAiWaiting 关闭；置于消息流底部 -->
      <div v-if="props.aiWaiting" class="wait-banner" role="status" aria-live="polite">
        <span class="wait-spinner" aria-hidden="true" />
        <span class="wait-text">{{ waitElapsed >= 30 ? 'AI 仍在处理' : 'AI 思考中' }}</span>
        <span class="wait-dots" aria-hidden="true" />
        <span v-if="waitElapsed > 0" class="wait-elapsed" aria-hidden="true">{{ waitElapsed }}s</span>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* [font-weight-light-v1] 全文字重降一档：600→500、500→400，对齐 TRAE 视觉轻量化 */
/* TerminalPane styles — 合并历史 7 层覆盖为单层
 * [WHY] 早期迭代逐层叠加 !important（同选择器 5+ 处定义），视觉溯源困难；本合并层按最终生效值统一
 * [CONSTRAINT] 选择器与原定义一致，仅保留最终生效属性；不再用 !important
 * [CHANGE-IMPACT] 后续视觉调整改本层；不要重新引入覆盖层 */

.status.err {
  color: var(--danger);
}

/* ── 容器 ─────────────────────────────────────────── */
.terminal {
  padding: 0 50px;
  flex: 1 1 0;
  min-height: 0;
  @apply flex flex-col overflow-hidden;
  background: var(--bg);
}

.flow-timeline {
  @apply flex flex-col flex-nowrap items-stretch justify-start gap-0 overflow-hidden;
  padding: 0;
  min-height: 0;
  padding-bottom: 50px;
  max-height: none;
  background: transparent;
  flex: 1 1 0;
  font-size: 12px;
}

/* ── 消息流 ─────────────────────────────────────────── */
/* [script-progress-v1] 顶部进度条 */
.progress-header {
  @apply flex items-center;
  gap: 8px;
  padding: 8px 24px;
  max-width: 820px;
  margin: 0 auto;
  width: 100%;
  font-size: 11px;
  color: var(--text-3, #8b949e);
  border-bottom: 1px solid rgb(127 127 127 / 8%);
  flex-shrink: 0;
}
.progress-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgb(127 127 127 / 40%);
  flex-shrink: 0;
}
.progress-dot.is-active {
  background: var(--primary, #58a6ff);
  animation: vp-pulse 1.4s ease-in-out infinite;
}
.progress-text {
  font: 400 11px/1.4 var(--mono, monospace);
  letter-spacing: 0.2px;
}
.progress-bar {
  flex: 1 1 auto;
  height: 3px;
  border-radius: 2px;
  background: rgb(127 127 127 / 12%);
  overflow: hidden;
  max-width: 240px;
}
.progress-bar-fill {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #58a6ff, #3fb950);
  transition: width 0.3s ease;
}
.chat-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  width: 100%;
  max-width: 820px;
  margin: 0 auto;
  padding: 14px 24px 20px;
  gap: 6px;
  text-align: left;
  background: transparent;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui,
    sans-serif;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
  /* 滚动条细淡（替代 4 条 ::-webkit-scrollbar 规则） */
  @apply scroll-thin;
}

/* ── 空态 ─────────────────────────────────────────── */
.tree-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 96px 32px;
  margin: auto;
  text-align: center;
  color: var(--text-3);
  flex: 1 1 0;
}
.empty-title {
  font-size: 16px;
  font-weight: 400;
  color: var(--text-2);
  letter-spacing: 0;
}
.empty-sub {
  font-size: 13px;
  color: var(--text-3);
  opacity: 1;
}

/* ── 卡片基础（script / text / done 共用去框） ──── */
.script-card,
.text-card,
.done-summary {
  margin: 0;
  padding: 4px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  transition: background-color 0.14s ease;
}
.script-card:hover {
  background: rgb(127 127 127 / 3%);
}
/* [round-divider-v1] 轮次分隔条：左右渐隐线 + 中央圆角标签，弱视觉强化"分组" */
/* [rd-css-v1] .round-divider* 样式已迁至 RoundDivider.vue */
.script-card-head,
.text-card-head {
  @apply flex items-center gap-1.5 mb-0.5 text-[10.5px] leading-[1.2];
  color: var(--text-3);
  letter-spacing: 0.2px;
}
.script-card-head.is-clickable {
  cursor: pointer;
  user-select: none;
  margin: -2px -6px;
  padding: 2px 6px;
  border-radius: 6px;
  transition: background-color 0.14s ease;
}
.script-card-head.is-clickable:hover {
  background: rgb(127 127 127 / 6%);
}
.script-card-head.is-clickable:focus-visible {
  outline: 2px solid var(--primary, #58a6ff);
  outline-offset: 2px;
}
/* [collapse-indicator] 折叠态指示：可展开卡片右缘显示 ▸，展开时旋转为 ▾ */
.script-card-head.is-clickable::after {
  content: '▸';
  flex: 0 0 auto;
  margin-left: 4px;
  font-size: 9px;
  line-height: 1;
  color: var(--text-3);
  opacity: 0.6;
  transition: transform 0.15s ease;
}
.script-card-head.is-clickable[aria-expanded='true']::after {
  transform: rotate(90deg);
}
.script-card-badge,
.text-card-badge {
  flex: 0 0 auto;
  padding: 1px 7px;
  border-radius: 4px;
  background: rgb(110 118 129 / 25%);
  color: var(--text-2, #c9d1d9);
  font: 400 10px/1.5 var(--mono, monospace);
  letter-spacing: 0.4px;
}
.text-card-kind {
  color: var(--text-3, #8b949e);
  font-size: 11.5px;
}
/* [phase-icon-restore-v1] 恢复 .script-card-phase 与 .phase-icon；语言徽章样式不恢复 */
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
@keyframes vp-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.5;
    transform: scale(0.85);
  }
}
.script-card-time {
  flex: 0 0 auto;
  margin-left: auto;
  font: 400 11px/1.1 var(--mono, monospace);
  color: var(--text-3, #8b949e);
  opacity: 0.62;
  font-variant-numeric: tabular-nums;
}
.script-card-desc {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-2, #c9d1d9);
  font-size: 12px;
  font-weight: 300;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.why-block {
  @apply flex items-start gap-2;
  padding: 4px 0 8px;
  margin-bottom: 4px;
  border-bottom: 1px dashed var(--border, #30363d);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-3, #8b949e);
}
.why-label {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--surface-3, #161b22);
  font: 400 10px/1.4 var(--mono, monospace);
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
  background: transparent;
  border-top: 1px dashed var(--border, #30363d);
  border-radius: 0;
  max-height: 360px;
  overflow-y: auto;
  @apply scroll-thin;
}
.script-card-tail .tail-pre {
  margin: 0;
  padding: 2px 0;
  font: 12px/1.6 var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
  white-space: pre-wrap;
  word-break: break-word;
  tab-size: 2;
}
.script-card-tail .tail-pre.err {
  color: var(--danger, #ef4444);
}
.done-summary-head {
  @apply flex items-center gap-2;
  font:
    400 14px/1.5 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  color: var(--text, #e6edf3);
  letter-spacing: 0;
  margin: 0 0 16px;
  padding: 0;
  border-bottom: 0;
}
.done-summary-head::before {
  content: '\2713';
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: rgb(63 185 80 / 15%);
  color: #3fb950;
  font-size: 12px;
}
.done-summary-body {
  margin: 0;
  font:
    13px/1.75 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  color: var(--text-2);
  word-break: break-word;
}
.done-summary-body :deep(p) {
  margin: 0 0 10px;
}
.done-summary-body :deep(p:last-child) {
  margin-bottom: 0;
}
.done-summary-body :deep(h1) {
  margin: 22px 0 12px;
  font-size: 20px;
  font-weight: 400;
  color: var(--text, #e6edf3);
  line-height: 1.35;
}
.done-summary-body :deep(h2) {
  margin: 20px 0 10px;
  font-size: 18px;
  font-weight: 400;
  color: var(--text, #e6edf3);
  line-height: 1.4;
}
.done-summary-body :deep(h3) {
  margin: 18px 0 8px;
  font-size: 16px;
  font-weight: 400;
  color: var(--text, #e6edf3);
  line-height: 1.4;
}
.done-summary-body :deep(h1:first-child),
.done-summary-body :deep(h2:first-child),
.done-summary-body :deep(h3:first-child) {
  margin-top: 0;
}
.done-summary-body :deep(strong) {
  font-weight: 400;
  color: var(--text, #e6edf3);
}
.done-summary-body :deep(table) {
  width: 100%;
  margin: 10px 0 14px;
  border-collapse: collapse;
  font-size: 13px;
  table-layout: auto;
}
.done-summary-body :deep(thead) {
  display: table-header-group;
}
.done-summary-body :deep(th),
.done-summary-body :deep(td) {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #30363d);
  text-align: left;
  vertical-align: top;
}
.done-summary-body :deep(th) {
  font-weight: 400;
  color: var(--text-2, #c9d1d9);
  background: transparent;
  border-bottom: 1px solid var(--border, #30363d);
}
.done-summary-body :deep(td) {
  color: var(--text, #e6edf3);
}
.done-summary-body :deep(ul),
.done-summary-body :deep(ol) {
  margin: 6px 0 10px;
  padding-left: 22px;
}
.done-summary-body :deep(li) {
  margin: 3px 0;
}
.done-summary-body :deep(blockquote) {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--border, #30363d);
  color: var(--text-2, #c9d1d9);
}
.done-summary-body :deep(hr) {
  margin: 14px 0;
  border: 0;
  border-top: 1px solid var(--border, #30363d);
}
.done-summary-body :deep(.md-pre) {
  margin: 10px 0;
  padding: 12px 14px;
  background: var(--surface-2, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre;
}
.done-summary-body :deep(.md-pre code) {
  font: 12px/1.6 var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
}
.done-summary-body :deep(.md-inline) {
  padding: 1px 5px;
  background: rgb(110 118 129 / 25%);
  border-radius: 4px;
  font: 12px var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
}
/* ── 等待 AI 回复指示条 ─────────────────────────── */
.wait-banner {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  align-self: center;
  margin: 0 auto 14px;
  padding: 7px 16px;
  background: rgb(88 166 255 / 8%);
  border: 1px solid rgb(88 166 255 / 24%);
  border-radius: 999px;
  color: var(--primary, #58a6ff);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.2px;
  flex-shrink: 0;
  box-shadow: 0 4px 14px rgb(88 166 255 / 10%);
  backdrop-filter: blur(6px);
  animation: wait-fadein 0.2s ease-out;
}
@keyframes wait-fadein {
  from {
    opacity: 0;
    transform: translateY(-2px) scale(0.995);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.wait-spinner {
  display: inline-block;
  box-sizing: border-box;
  width: 12px;
  height: 12px;
  border: 2px solid rgb(88 166 255 / 18%);
  border-top-color: var(--primary, #58a6ff);
  border-right-color: rgb(88 166 255 / 55%);
  border-radius: 50%;
  animation: wait-spin 0.9s linear infinite;
  flex-shrink: 0;
}
@keyframes wait-spin {
  to {
    transform: rotate(360deg);
  }
}
.wait-dots::after {
  content: '';
  animation: wait-dots 1.4s steps(4, end) infinite;
}
.wait-elapsed {
  margin-left: 4px;
  padding: 1px 7px;
  font:
    600 10.5px/1.4 ui-monospace,
    monospace;
  color: var(--primary, #58a6ff);
  background: rgb(88 166 255 / 10%);
  border-radius: 999px;
  letter-spacing: 0.3px;
  font-variant-numeric: tabular-nums;
}
@keyframes wait-dots {
  0%,
  20% {
    content: '';
  }
  40% {
    content: '.';
  }
  60% {
    content: '..';
  }
  80%,
  100% {
    content: '...';
  }
}
</style>
