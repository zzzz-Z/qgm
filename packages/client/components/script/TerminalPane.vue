<template>
  <section class="terminal">
    <!-- [flow-timeline] 全流程时间线 -->
    <div class="flow-timeline">
      <!-- [ai-wait-banner-v1] 等待 AI 回复指示条：收到首 token / reply 后由 stopAiWaiting 关闭 -->
      <div v-if="props.aiWaiting" class="wait-banner" role="status" aria-live="polite">
        <span class="wait-spinner" aria-hidden="true" />
        <span class="wait-text">{{ waitElapsed >= 30 ? 'AI 仍在处理' : 'AI 思考中' }}</span>
        <span class="wait-dots" aria-hidden="true" />
        <span v-if="waitElapsed > 0" class="wait-elapsed" aria-hidden="true">{{ waitElapsed }}s</span>
      </div>
      <div ref="chatListRef" class="chat-list" @scroll="onChatScroll">
        <!-- [script-history-cards-v1] 每轮脚本 desc：Markdown 渲染；来源 busEvents（已持久化到 localStorage） -->
        <template v-for="card in timelineItems" :key="card.key">
          <div v-if="card.type === 'script'" class="script-card" :class="card.phaseClass">
            <div class="script-card-head">
              <!-- <span class="script-card-title">脚本</span> -->
              <!-- <span class="script-card-badge">{{ card.langLabel }}</span> -->
              <span class="script-card-phase">{{ card.phaseLabel }}</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
              <button
                v-if="card.stdoutTail || card.stderrTail"
                class="script-card-toggle"
                type="button"
                @click="toggleCard(card.key)"
              >
                {{ isCardExpanded(card) ? '▾' : '▸' }} 输出
              </button>
            </div>
            <div class="script-card-body" v-html="card.html" />
            <div v-if="isCardExpanded(card) && (card.stdoutTail || card.stderrTail)" class="script-card-tail">
              <pre
                v-if="card.stdoutTail"
                class="tail-pre"
                :style="{ '--tw-duration': `${Math.min(2.5, Math.max(0.4, card.stdoutTail.length / 300))}s` }"
              >{{ card.stdoutTail }}</pre>
              <pre
                v-if="card.stderrTail"
                class="tail-pre err"
                :style="{ '--tw-duration': `${Math.min(2.5, Math.max(0.4, card.stderrTail.length / 300))}s` }"
              >{{ card.stderrTail }}</pre>
            </div>
          </div>
          <!-- [done-persist-v1] 总结卡片（来自事件流，刷新后保留） -->
          <section v-else-if="card.type === 'done'" class="done-summary">
            <div class="done-summary-head">
              任务完成 · 总结
            </div>
            <div class="done-summary-body" v-html="card.html" />
          </section>
          <!-- [non-cjs-render-v1] 非 cjs 文本卡片：与总结同排版 -->
          <section v-else-if="card.type === 'text'" class="text-card">
            <header class="text-card-head">
              <span class="text-card-badge">AI</span>
              <span class="text-card-kind">{{ card.kindLabel }}</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="card.html" />
          </section>
          <!-- [ask-display-v1] 用户提问卡：badge 用「你」区分 AI，其余结构与 text-card 一致 -->
          <section v-else class="text-card ask-card">
            <header class="text-card-head">
              <span class="text-card-badge ask-badge">你</span>
              <span class="text-card-kind">提问</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="card.html" />
          </section>
        </template>

        <!-- [empty-state-v2] 空态：无卡片 / 无输出 / 无总结 -->
        <div v-if="!running && !twStdout && !twStderr && timelineItems.length === 0" class="tree-empty">
          <div class="empty-title">
            还没有执行记录
          </div>
          <div class="empty-sub">
            点击「运行」开始自动化循环
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useIntervalFn } from '@vueuse/core'
// [raw-output-fold-v1] PLAN 5.2 第四层：原始输出折叠
// [done-summary-md-v1] 复用项目已有极简 markdown 渲染器（不引入新依赖）
import { renderMarkdown } from '../../composables/useMarkdown.js'
// [script-history-cards-v1] 事件流单例（localStorage 持久化），用于渲染每轮脚本 desc
import { useEventBus } from '../../composables/ui/useEventStream'

/** 组件接收的 props 定义 */
const props = defineProps<{

  running: boolean
  twStdout: string
  twStderr: string
  twLines: string[]
  twErrLines: string[]
  doneSummary?: string // [done-summary-channel-v1]
  lineClass: (line: string) => string
  // [ai-wait-banner-v1] 等待 AI 回复中；由 ScriptPanel 透传 useAiWaiting().waiting
  aiWaiting?: boolean
}>()

/** 派发 */
// [emit-unused-v1] 去掉变量赋值：模板未消费此 emit，赋值触发 unused-imports warning
defineEmits<{ (e: 'applyTemplate', code: string): void }>()

const { events: busEvents } = useEventBus()

// [ai-wait-timer-v1] 等待时长本地计时：aiWaiting 为 true 时启动，false 时停止并归零
// [WHY] 用本地 interval 而非改 useAiWaiting 契约（避免污染其他消费方）；仅用于展示层
// [CONSTRAINT] useIntervalFn 组件卸载自动清理；watch 双向同步启停
// [CHANGE-IMPACT] 与 wait-banner 模板成对；去掉 watch 会让秒数永远为 0
const waitElapsed = ref(0)
const { pause: pauseWaitTimer, resume: resumeWaitTimer } = useIntervalFn(() => {
  waitElapsed.value += 1
}, 1000, { immediate: false })
watch(() => props.aiWaiting, (v) => {
  if (v) { waitElapsed.value = 0; resumeWaitTimer() }
  else { pauseWaitTimer(); waitElapsed.value = 0 }
}, { immediate: true })

/** 阶段中文标签表；未命中回退为原值 */
const PHASE_LABEL: Record<string, string> = {
  pending: '等待执行',
  running: '执行中',
  done: '已完成',
  error: '失败',
}

/**
 * 每轮脚本卡片：从 busEvents 提取 run:start 事件（desc/why/lang/phase）
 * [WHY] 事件流 updateKey 原地更新，同一脚本多次 phase 变化只留一条；desc 用 renderMarkdown 呈现
 * [CONSTRAINT] 仅收 payload.desc 或 summary 非空的事件；无内容的不渲染，避免空卡
 * [CHANGE-IMPACT] 依赖 App.vue / useRunner 的 emit 契约（run:start + payload.desc/why/lang/phase）
 */
const timelineItems = computed(() => {
  interface ScriptItem { type: 'script', key: string, langLabel: string, phaseLabel: string, phaseClass: string, html: string, timeLabel: string, stdoutTail: string, stderrTail: string }
  interface TextItem { type: 'text', key: string, kindLabel: string, timeLabel: string, html: string }
  interface DoneItem { type: 'done', key: string, timeLabel: string, html: string }
  // [ask-display-v1] 用户提问卡：ScriptPanel.runSmart 发送成功后 emit('ai:ask') 写入
  interface AskItem { type: 'ask', key: string, timeLabel: string, html: string }
  const out: Array<ScriptItem | TextItem | DoneItem | AskItem> = []
  for (const ev of busEvents.value) {
    // [ask-display-v1] 用户提问卡：ScriptPanel.runSmart 成功 copyAndFill 后 emit('ai:ask')
    // [CONSTRAINT] 只收 payload.text 非空事件，避免空卡；与 ai:done 同结构仅 badge 不同
    if (ev.kind === 'ai:ask') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      const d0 = new Date(ev.ts || Date.now())
      const pad0 = (n: number) => String(n).padStart(2, '0')
      const timeLabel0 = `${pad0(d0.getHours())}:${pad0(d0.getMinutes())}:${pad0(d0.getSeconds())}`
      out.push({
        type: 'ask',
        key: `ask-${ev.id}`,
        timeLabel: timeLabel0,
        html: renderMarkdown(text),
      })
      continue
    }
    // [done-persist-v1] 总结卡片：来自 ai:done 事件（方案 A，持久化）
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
    // [non-cjs-render-v1] 非 cjs 文本（ai:plain / ai:multi）按时间顺序混排为 Markdown 卡片
    // [CONSTRAINT] 只收 payload.text 非空的事件
    if (ev.kind === 'ai:plain' || ev.kind === 'ai:multi') {
      const tp = (ev.payload || {}) as Record<string, unknown>
      const text = String(tp.text || '').trim()
      if (!text) continue
      const d0 = new Date(ev.ts || Date.now())
      const pad0 = (n: number) => String(n).padStart(2, '0')
      const timeLabel0 = `${pad0(d0.getHours())}:${pad0(d0.getMinutes())}:${pad0(d0.getSeconds())}`
      const kindLabel = ev.kind === 'ai:multi' ? '多块回复' : 'AI 回复'
      out.push({
        type: 'text',
        key: `text-${ev.id}`,
        kindLabel,
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
    // [script-cards-filter-v1] 跳过旧事件（payload 无 why 且 desc 为默认值）产生的空卡
    if (!why && (!desc || desc === '执行脚本')) continue
    // [card-typewriter-v1] 提取打字机 tail：useRunner.emitStep 每次节流（250ms）携带
    const stdoutTail = String(p.stdoutTail || '')
    const stderrTail = String(p.stderrTail || '')
    const parts: string[] = []
    if (desc) parts.push(`**${desc}**`)
    if (why) parts.push(`> ${why}`)
    const md = parts.join('\n\n')
    const langLabel = lang === 'bash' ? 'BASH' : lang === 'cjs' ? 'CJS' : 'JS'
    // [card-ts-v1] 时间戳：HH:MM:SS，本地时区；ev.ts 为事件更新时刻（updateKey 命中时刷新）
    const d = new Date(ev.ts || Date.now())
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeLabel = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    out.push({ type: 'script', key, langLabel, phaseLabel: PHASE_LABEL[phase] || phase, phaseClass: `phase-${phase}`, html: renderMarkdown(md), timeLabel, stdoutTail, stderrTail })
  }

  return out
})

// [card-typewriter-v1] 折叠展开的卡片 key 集合；用 Set 替换触发响应
const expandedCards = ref<Set<string>>(new Set())

// [default-collapsed-v1] 已删 latestScriptKey 自动展开：用户需求"输出默认全部收起"，所有卡初始收起，需手动点开
/**
 * 切换卡片输出的折叠状态
 * [CONSTRAINT] 必须替换引用（Set 非响应式内部变更），否则模板不重渲染
 * @param key 卡片 updateKey
 */
function toggleCard(key: string): void {
  const next = new Set(expandedCards.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedCards.value = next
}

/**
 * 判定卡片是否展开输出区
 * [WHY] 执行中/等待中的卡片应默认展开以展示打字机输出；用户手动 toggle 覆盖默认行为
 * [CONSTRAINT] 手动 toggle 与自动展开叠加：用户展开过的卡片即使在 done 态也保持展开
 * @param card scriptCards 单项；只用 key 与 phaseClass
 */
function isCardExpanded(card: { key: string }): boolean {
  // [default-collapsed-v1] 仅凭用户手动展开记录；不再按 phase 自动展开
  return expandedCards.value.has(card.key)
}

/** 列表 */
const chatListRef = ref<HTMLElement | null>(null)

// [done-summary-bottom-v1] 总结写入后自动滚到底部，确保用户第一眼看到
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
/**
 * 响应 Chat Scroll
 */
function onChatScroll(): void { /* 由父组件按需注入滚动处理 */ }
</script>

<style scoped>
.status.err {
  color: var(--danger);
}

.terminal {
  padding: 0 50px;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  background: var(--bg) !important;
}

/* [chat-list-structure] 仅保留结构属性（撑满高度 + 滚动）；视觉属性由 [codex-final-v1] 覆盖层统一定义 */
.chat-list {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  width: 100%;
}

.tree-empty {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 14px !important;
  padding: 40px 24px !important;
  color: var(--text-3) !important;
  text-align: center !important;
  flex: 1 1 0 !important;
}

.empty-title {
  font-size: 14px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}

.empty-sub {
  font-size: 12px !important;
  color: var(--text-3) !important;
}

.chat-list .tree-empty {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  margin: auto !important;
  padding: 40px 24px !important;
  gap: 16px !important;
}

.chat-list .tree-empty .empty-title {
  font-size: 15px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}

.chat-list .tree-empty .empty-sub {
  font-size: 12px !important;
  color: var(--text-3) !important;
}

.flow-timeline .chat-list {
  display: flex !important;
  flex-direction: column !important;
  align-items: flex-start !important;
  justify-content: flex-start !important;
  text-align: left !important;
  flex: 1 1 0 !important;
  min-height: 0 !important;
  width: 100% !important;
  max-width: none !important;
  margin: 0 !important;
  padding: 10px 14px !important;
  gap: 8px !important;
  overflow-y: auto !important;
  background: transparent !important;
}

.flow-timeline .chat-list .tree-empty {
  display: flex !important;
  flex-direction: column !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
  margin: auto !important;
  width: 100% !important;
  padding: 40px 24px !important;
}

.chat-list .tree-empty {
  padding: 64px 24px !important;
  gap: 24px !important;
}

.chat-list .tree-empty .empty-title {
  font-size: 16px !important;
  font-weight: 600 !important;
  letter-spacing: 0.2px;
}

.chat-list .tree-empty .empty-sub {
  font-size: 12.5px !important;
  opacity: 0.9;
}

/* [codex-style-v1] 去卡片化：无边框无背景，仅左侧 3px 色条标识 phase 状态 */
.script-card {
  margin: 0;
  padding: 8px 0 8px 12px;
  border: 0;
  border-left: 3px solid var(--border, #30363d);
  border-radius: 0;
  background: transparent;
}
.script-card.phase-running {
  border-left-color: var(--primary, #58a6ff);
}
.script-card.phase-pending {
  border-left-color: var(--warning, #d29922);
}
.script-card.phase-done {
  border-left-color: var(--success, #3fb950);
}
.script-card.phase-error {
  border-left-color: var(--danger, #f85149);
}
.script-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-3, #8b949e);
}
.script-card-badge {
  padding: 1px 7px;
  border-radius: 4px;
  background: rgb(110 118 129 / 25%);
  color: var(--text-2, #c9d1d9);
  font: 600 10px/1.5 var(--mono, monospace);
  letter-spacing: 0.4px;
}
/* [card-title-v1] 固定标题「脚本」+ phase 着色 */
.script-card-title {
  color: var(--text-3, #8b949e);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.script-card-phase {
  color: var(--text-3, #8b949e);
  font-size: 11.5px;
  font-weight: 500;
}
/* [card-phase-color-v1] 按 phase 着色 */
.script-card.phase-running .script-card-phase {
  color: var(--primary, #58a6ff);
  animation: card-pulse 1.6s ease-in-out infinite;
}
.script-card.phase-pending .script-card-phase {
  color: var(--warning, #d29922);
}
.script-card.phase-done .script-card-phase {
  color: var(--success, #3fb950);
}
.script-card.phase-error .script-card-phase {
  color: var(--danger, #f85149);
}
@keyframes card-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.55;
  }
}
.script-card-body {
  padding: 0;
  font:
    13.5px/1.75 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  color: var(--text, #e6edf3);
  word-break: break-word;
}
.script-card-body :deep(p) {
  margin: 0 0 8px;
}
.script-card-body :deep(p:last-child) {
  margin-bottom: 0;
}

/* [card-ui-polish-v1] 时间戳 + 折叠按钮 + tail 区 */
.script-card-time {
  margin-left: auto;
  color: var(--text-3, #8b949e);
  font: 11px/1 var(--mono, monospace);
  opacity: 0.75;
}
.script-card-toggle {
  padding: 2px 8px;
  background: transparent;
  border: 1px solid var(--border, #30363d);
  border-radius: 4px;
  color: var(--text-3, #8b949e);
  font: 11px/1.4 inherit;
  cursor: pointer;
  transition: all 0.12s ease;
}
.script-card-toggle:hover {
  border-color: var(--primary, #2563eb);
  color: var(--primary, #2563eb);
}
.script-card-tail {
  padding: 8px 14px 12px;
  border-top: 1px dashed var(--border, #30363d);
  background: var(--surface-2, #0d1117);
  max-height: 260px;
  overflow-y: auto;
}
.tail-pre {
  margin: 0;
  padding: 4px 0;
  font: 11.5px/1.55 var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
  white-space: pre-wrap;
  word-break: break-all;
}
.tail-pre.err {
  color: var(--danger, #ef4444);
}

/* [codex-style-v1] 去卡片化：与 script-card 统一，无框无底、仅左侧色条 */
.text-card {
  margin: 0;
  padding: 8px 0 8px 12px;
  border: 0;
  border-left: 3px solid var(--border, #30363d);
  border-radius: 0;
  background: transparent;
}
.text-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--text-3, #8b949e);
}
.text-card-badge {
  padding: 1px 7px;
  border-radius: 4px;
  background: rgb(110 118 129 / 25%);
  color: var(--text-2, #c9d1d9);
  font: 600 10px/1.5 var(--mono, monospace);
  letter-spacing: 0.4px;
}
.text-card-kind {
  color: var(--text-3, #8b949e);
  font-size: 11.5px;
}
.script-card-body :deep(strong) {
  color: var(--text, #e6edf3);
  font-weight: 600;
}
.script-card-body :deep(blockquote) {
  margin: 6px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--border, #30363d);
  color: var(--text-2, #c9d1d9);
}
.script-card-body :deep(.md-pre) {
  margin: 8px 0;
  padding: 10px 12px;
  background: var(--surface-2, #0d1117);
  border: 1px solid var(--border, #30363d);
  border-radius: 6px;
  overflow-x: auto;
  white-space: pre;
}
.script-card-body :deep(.md-pre code) {
  font: 12px/1.55 var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
}
.script-card-body :deep(.md-inline) {
  padding: 1px 5px;
  background: rgb(110 118 129 / 25%);
  border-radius: 4px;
  font: 12px var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
}

/* [codex-style-v1] 去卡片化：与 script-card 统一；左侧绿色条标识成功总结 */
.done-summary {
  margin: 0;
  padding: 8px 0 8px 12px;
  border: 0;
  border-left: 3px solid var(--success, #3fb950);
  border-radius: 0;
  background: transparent;
}
.done-summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font:
    600 14px/1.5 -apple-system,
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
  content: '✓';
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
    13.5px/1.75 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  color: var(--text, #e6edf3);
  word-break: break-word;
}
.done-summary-body :deep(p) {
  margin: 0 0 10px;
}
.done-summary-body :deep(p:last-child) {
  margin-bottom: 0;
}
/* [align-left-v1] H1/H2/H3 分档：DeepSeek 原生 H2 约 18px；标题与左边缘对齐 */
.done-summary-body :deep(h1) {
  margin: 22px 0 12px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text, #e6edf3);
  line-height: 1.35;
}
.done-summary-body :deep(h2) {
  margin: 20px 0 10px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text, #e6edf3);
  line-height: 1.4;
}
.done-summary-body :deep(h3) {
  margin: 18px 0 8px;
  font-size: 16px;
  font-weight: 600;
  color: var(--text, #e6edf3);
  line-height: 1.4;
}
.done-summary-body :deep(h1:first-child),
.done-summary-body :deep(h2:first-child),
.done-summary-body :deep(h3:first-child) {
  margin-top: 0;
}
.done-summary-body :deep(h1:first-child),
.done-summary-body :deep(h2:first-child),
.done-summary-body :deep(h3:first-child) {
  margin-top: 0;
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
  font-weight: 600;
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
/* ============================================================
 * [codex-final-v1] Codex / Claude Code 风视觉覆盖层
 * [WHY] 历史 7 处 .flow-timeline 定义层叠为垂直多步布局，与目标"单行紧凑状态条"不符；
 *       本覆盖层置于样式段末尾，依赖 CSS 层叠顺序统一为最终视觉，不改动上方任何定义
 * [CONSTRAINT] 全部使用 !important 保证覆盖先前 7 处定义；仅调视觉参数，不删历史代码
 * [CHANGE-IMPACT] 若后续做样式段整体重构，本层内容应并入主定义后删除
 * ============================================================ */

/* ① 主容器：纵向撑满（含 chat-list）；误压扁修正 [flow-timeline-fix-v1] */
/* [WHY] 上轮误判 .flow-timeline 为顶部状态条并压成 36px/overflow:hidden，导致消息列表被裁；
 *       实际它是 .terminal 下的唯一主容器，内部结构为 .chat-list；需纵向撑满、overflow:hidden 交由子级滚动
 * [CONSTRAINT] 无状态条 DOM 节点，原 flow-step / script-header 子选择器均为孤儿，不影响本次修正
 * [CHANGE-IMPACT] 恢复后 .chat-list 才有高度撑满与滚动上下文 */
.flow-timeline {
  display: flex !important;
  flex-direction: column !important;
  flex-wrap: nowrap !important;
  align-items: stretch !important;
  justify-content: flex-start !important;
  gap: 0 !important;
  padding: 0 !important;
  border-bottom: 0 !important;
  min-height: 0 !important;
  max-height: none !important;
  overflow: hidden !important;
  background: transparent !important;
  flex: 1 1 0 !important;
  font-size: 12px !important;
}

/* ② 消息流：系统字体 + 居中宽度 + 舒适留白（与输入框字体一致） */
.chat-list,
.flow-timeline .chat-list {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui,
    sans-serif !important;
  font-size: 14px !important;
  line-height: 1.7 !important;
  color: var(--text) !important;
  max-width: 820px !important;
  margin: 0 auto !important;
  padding: 20px 24px 32px !important;
  gap: 16px !important;
  text-align: left !important;
  align-items: stretch !important;
}

/* ③ 实时输出：与卡片同款"去框+左侧色条"，不再独立成卡 */

/* ④ 空态：简洁居中（Codex 首启屏风） */
.chat-list .tree-empty {
  padding: 80px 24px !important;
  gap: 12px !important;
  align-items: center !important;
  justify-content: center !important;
  text-align: center !important;
}

.chat-list .tree-empty .empty-title {
  font-size: 15px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
  letter-spacing: 0 !important;
}

.chat-list .tree-empty .empty-sub {
  font-size: 13px !important;
  color: var(--text-3) !important;
  opacity: 1 !important;
}

/* ⑤ 卡片内标题与正文与系统字体对齐 */
.script-card-body,
.done-summary-body {
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui,
    sans-serif !important;
  font-size: 14px !important;
  line-height: 1.7 !important;
}

/* ⑥ 卡片头部标签弱化，仅保留时间与 phase 文字，与 Codex 消息头一致 */
.script-card-head,
.text-card-head {
  margin-bottom: 6px !important;
  font-size: 12px !important;
  color: var(--text-3) !important;
}

/* ============================================================
 * [visual-polish-v2] 视觉精修层
 * [WHY] 孤儿清理完成后，进一步优化消息流的呼吸感、卡片反馈、空态排版
 * [CONSTRAINT] 仍用 !important 覆盖；仅调视觉参数，不改结构
 * [CHANGE-IMPACT] 与 [codex-final-v1] 同层叠加，改动集中在末尾便于统一回滚
 * ============================================================ */

/* ① 消息流：更大呼吸 + 上边距留白 */
.chat-list,
.flow-timeline .chat-list {
  gap: 16px !important;
  padding: 20px 20px 32px !important;
}

/* ② 卡片：hover 时色条加亮 + 微右移，形成"这条消息在响应我"的反馈 */
.script-card,
.text-card,
.done-summary {
  transition:
    border-left-color 0.15s ease,
    transform 0.15s ease !important;
}
.script-card:hover,
.text-card:hover,
.done-summary:hover {
  border-left-width: 4px !important;
}

/* ③ 卡片头部：时间戳与 phase 间距与对齐微调 */
.script-card-head,
.text-card-head {
  margin-bottom: 10px !important;
  gap: 10px !important;
  letter-spacing: 0.2px !important;
}

/* ④ 时间戳：更淡更小，仅作元信息 */
.script-card-time {
  font-size: 10.5px !important;
  opacity: 0.65 !important;
}

/* ⑤ phase 标签：圆点 + 文字间距，视觉上更醒 */
.script-card-phase {
  letter-spacing: 0.3px !important;
  font-weight: 600 !important;
  display: inline-flex !important;
  align-items: center !important;
  gap: 6px !important;
}
.script-card.phase-running .script-card-phase::before,
.script-card.phase-pending .script-card-phase::before,
.script-card.phase-done .script-card-phase::before,
.script-card.phase-error .script-card-phase::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  vertical-align: middle;
}
.script-card.phase-running .script-card-phase::before {
  animation: vp-pulse 1.4s ease-in-out infinite;
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

/* ⑥ 滚动条：更细更淡，视觉噪音最小化 */
.chat-list::-webkit-scrollbar {
  width: 6px;
}
.chat-list::-webkit-scrollbar-thumb {
  background: rgba(127, 127, 127, 0.22);
  border-radius: 999px;
}
.chat-list::-webkit-scrollbar-thumb:hover {
  background: rgba(127, 127, 127, 0.38);
}
.chat-list::-webkit-scrollbar-track {
  background: transparent;
}

/* ⑦ 空态：Codex 首启屏风 */
.chat-list .tree-empty {
  gap: 8px !important;
  padding: 96px 32px !important;
}
.chat-list .tree-empty .empty-title {
  font-size: 16px !important;
  font-weight: 500 !important;
  color: var(--text-2) !important;
}
.chat-list .tree-empty .empty-sub {
  font-size: 13px !important;
  color: var(--text-3) !important;
}

/* ⑧ 脚本卡片"输出"折叠按钮：轻量化 */
.script-card-toggle {
  border: 0 !important;
  background: transparent !important;
  color: var(--text-3) !important;
  padding: 2px 6px !important;
  opacity: 0.7 !important;
  transition: opacity 0.15s ease !important;
}
.script-card-toggle:hover {
  opacity: 1 !important;
  color: var(--primary) !important;
}

/* ⑨ script-card-tail：与卡片同底，弱化边界 */
.script-card-tail {
  margin-top: 8px !important;
  padding: 8px 0 0 !important;
  background: transparent !important;
  border-top: 1px dashed var(--border) !important;
  border-radius: 0 !important;
}

/* ============================================================
 * [ai-wait-banner-v1] 等待 AI 回复指示条
 * [WHY] 用户需求：点击发送到收到 AI 回复之间应可视化等待态；此前 aiWaiting ref 存在于 ScriptPanel 但未透传
 * [CONSTRAINT] 置于 .flow-timeline 内、.chat-list 之上；v-if 由 props.aiWaiting 控制，随 stopAiWaiting 自动隐藏
 * [CHANGE-IMPACT] 与 ScriptPanel 的 <TerminalPane :ai-waiting> 成对；改颜色/布局需同步覆盖层可视优先级
 * ============================================================ */
.wait-banner {
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  gap: 8px !important;
  padding: 10px 20px !important;
  background: linear-gradient(90deg, transparent 0%, rgba(88, 166, 255, 0.06) 50%, transparent 100%) !important;
  border-bottom: 1px dashed rgba(88, 166, 255, 0.18) !important;
  color: var(--primary, #58a6ff) !important;
  font-size: 12.5px !important;
  font-weight: 500 !important;
  letter-spacing: 0.2px !important;
  flex-shrink: 0 !important;
  animation: wait-fadein 0.2s ease-out !important;
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

/* [spinner-polish-v1] 旋转圈：三色描边分层，旋转方向感更明确 */
.wait-spinner {
  display: inline-block !important;
  width: 12px !important;
  height: 12px !important;
  border: 2px solid rgba(88, 166, 255, 0.18) !important;
  border-top-color: var(--primary, #58a6ff) !important;
  border-right-color: rgba(88, 166, 255, 0.55) !important;
  border-radius: 50% !important;
  animation: wait-spin 0.9s linear infinite !important;
  flex-shrink: 0 !important;
  box-sizing: border-box !important;
}

@keyframes wait-spin {
  to {
    transform: rotate(360deg);
  }
}

/* 省略号：3 点逐次显现（steps 动画） */
.wait-dots::after {
  content: '';
  animation: wait-dots 1.4s steps(4, end) infinite;
}

/* 时长徽标：弱化处理，仅作时间感知补充 */
.wait-elapsed {
  margin-left: 4px !important;
  padding: 1px 7px !important;
  font:
    600 10.5px/1.4 ui-monospace,
    monospace !important;
  color: var(--primary, #58a6ff) !important;
  background: rgba(88, 166, 255, 0.1) !important;
  border-radius: 999px !important;
  letter-spacing: 0.3px !important;
  /* [css-fix-v1] 上一轮的 tabular-nums: 1 是无效 CSS；正确写法为 font-variant-numeric */
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
/* ============================================================
 * [tail-typewriter-v1] 输出打字机动画
 * [WHY] 用户需求：tail 输出用打字机显示，与 wait-banner 的 spinner 视觉呼应
 * [CONSTRAINT] clip-path 逐格揭示（steps(40)）；时长由模板 --tw-duration 按 tail 长度计算（0.4-2.5s）
 * [CHANGE-IMPACT] 只加动画不改布局；tail 内容变化触发 Vue 重渲染，动画随之重放
 * ============================================================ */
.script-card-tail .tail-pre {
  animation: tail-typing var(--tw-duration, 0.8s) steps(40, end) both !important;
}
@keyframes tail-typing {
  from {
    clip-path: inset(0 100% 0 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}
</style>
