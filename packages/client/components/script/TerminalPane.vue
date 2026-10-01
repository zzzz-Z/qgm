<template>
  <section class="terminal">
    <!-- [flow-timeline] 全流程时间线 -->
    <div class="flow-timeline">
      <div ref="chatListRef" class="chat-list" @scroll="onChatScroll">
        <!-- [script-history-cards-v1] 每轮脚本 desc：Markdown 渲染；来源 busEvents（已持久化到 localStorage） -->
        <template v-for="card in timelineItems" :key="card.key">
          <div v-if="card.type === 'script'" class="script-card" :class="card.phaseClass">
            <div
              class="script-card-head"
              :class="{ 'is-clickable': !!(card.stdoutTail || card.stderrTail || card.why) }"
              @click="(card.stdoutTail || card.stderrTail || card.why) ? toggleCard(card.key) : null"
            >
              <span class="script-card-phase">{{ card.phaseLabel }}</span>
              <span class="script-card-desc">{{ card.desc }}</span>
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </div>
            <div
              v-if="isCardExpanded(card) && (card.stdoutTail || card.stderrTail || card.why)"
              class="script-card-tail"
            >
              <!-- [why-fold-v1] why 从卡片主体迁移至此：仅展开时可见，与输出同屏 -->
              <div v-if="card.why" class="why-block">
                <span class="why-label">WHY</span>
                <span class="why-text">{{ card.why }}</span>
              </div>
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
              <span class="script-card-time">{{ card.timeLabel }}</span>
            </header>
            <div class="done-summary-body" v-html="card.html" />
          </section>
          <!-- [ask-display-v1] 用户提问/回答卡：badge 用「你」区分 AI；回答额外走 answer-card 视觉 -->
          <section v-else class="text-card" :class="card.role === 'user-answer' ? 'answer-card' : 'ask-card'">
            <header class="text-card-head">
              <span class="text-card-badge" :class="card.role === 'user-answer' ? 'answer-badge' : 'ask-badge'">你</span>
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
      <!-- [ai-wait-banner-v1] 等待 AI 回复指示条：收到首 token / reply 后由 stopAiWaiting 关闭；置于消息流底部 -->
      <div v-if="props.aiWaiting" class="wait-banner" role="status" aria-live="polite">
        <span class="wait-spinner" aria-hidden="true" />
        <span class="wait-text">{{ waitElapsed >= 30 ? 'AI 仍在处理' : 'AI 思考中' }}</span>
        <span class="wait-dots" aria-hidden="true" />
        <span v-if="waitElapsed > 0" class="wait-elapsed" aria-hidden="true">{{ waitElapsed }}s</span>
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

interface ScriptItem {
  type: 'script'
  key: string
  langLabel: string
  phaseLabel: string
  phaseClass: string
  // [head-inline-v1] desc 从 body 前移到 header，与 phase / time 同行展示
  desc: string
  timeLabel: string
  stdoutTail: string
  stderrTail: string
  // [why-fold-v1] why 从卡片主体迁移至展开区，避免每张卡都占两行；空串表示无 why
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
// [ask-display-v1] 用户提问/回答卡：ScriptPanel.runSmart 与 App.vue ask 回答分支 emit('ai:ask')
// [ask-answer-display-v1] role='user-answer' 时展示为「回答」+ answer-badge，区分于「提问」
interface AskItem { type: 'ask', key: string, timeLabel: string, html: string, role?: 'user-answer' }

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
      // [ask-answer-display-v1] role 分流：'user-answer' 走回答卡样式；缺省按提问卡
      out.push({
        type: 'ask',
        key: `ask-${ev.id}`,
        timeLabel: timeLabel0,
        html: renderMarkdown(text),
        ...(tp.role === 'user-answer' ? { role: 'user-answer' as const } : {}),
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
    // [script-cards-filter-v1] 跳过旧事件（payload 无 why 且 desc 为默认值）产生的空卡
    if (!why && (!desc || desc === '执行脚本')) continue
    // [card-typewriter-v1] 提取打字机 tail：useRunner.emitStep 每次节流（250ms）携带
    const stdoutTail = String(p.stdoutTail || '')
    const stderrTail = String(p.stderrTail || '')
    // [head-inline-v1] desc 不再走 body markdown；直接作为 header 文本字段
    const langLabel = lang === 'bash' ? 'BASH' : lang === 'cjs' ? 'CJS' : 'JS'
    // [card-ts-v1] 时间戳：HH:MM:SS，本地时区；ev.ts 为事件更新时刻（updateKey 命中时刷新）
    const d = new Date(ev.ts || Date.now())
    const pad = (n: number) => String(n).padStart(2, '0')
    const timeLabel = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    out.push({ type: 'script', key, langLabel, phaseLabel: PHASE_LABEL[phase] || phase, phaseClass: `phase-${phase}`, desc, timeLabel, stdoutTail, stderrTail, why })
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
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--bg);
}

.flow-timeline {
  display: flex;
  flex-direction: column;
  flex-wrap: nowrap;
  align-items: stretch;
  justify-content: flex-start;
  gap: 0;
  padding: 0;
  min-height: 0;
  max-height: none;
  overflow: hidden;
  background: transparent;
  flex: 1 1 0;
  font-size: 12px;
}

/* ── 消息流 ─────────────────────────────────────────── */
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
  padding: 20px 24px 32px;
  gap: 16px;
  text-align: left;
  background: transparent;
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui,
    sans-serif;
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-2);
}

.chat-list::-webkit-scrollbar {
  width: 6px;
}
.chat-list::-webkit-scrollbar-thumb {
  background: rgb(127 127 127 / 22%);
  border-radius: 999px;
}
.chat-list::-webkit-scrollbar-thumb:hover {
  background: rgb(127 127 127 / 38%);
}
.chat-list::-webkit-scrollbar-track {
  background: transparent;
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
  font-weight: 500;
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
  padding: 8px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}

.script-card,
.text-card,
.done-summary {
  margin: 0;
  padding: 8px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.script-card-head,
.text-card-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
  font-size: 10.5px;
  line-height: 1.2;
  color: var(--text-3);
  letter-spacing: 0.2px;
}
.script-card-head.is-clickable {
  cursor: pointer;
  user-select: none;
}
.script-card-badge,
.text-card-badge {
  flex: 0 0 auto;
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
.script-card-phase {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0.3px;
  color: var(--text-3, #8b949e);
}
.script-card.phase-running .script-card-phase {
  color: var(--primary, #58a6ff);
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
.script-card-time {
  flex: 0 0 auto;
  margin-left: auto;
  font: 10.5px/1.1 var(--mono, monospace);
  color: var(--text-3, #8b949e);
  opacity: 0.65;
}
.script-card-desc {
  flex: 1 1 auto;
  min-width: 0;
  color: var(--text-2, #c9d1d9);
  font-size: 12px;
  font-weight: 500;
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
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--surface-3, #161b22);
  font: 600 10px/1.4 var(--mono, monospace);
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
}
.script-card-tail .tail-pre {
  margin: 0;
  padding: 4px 0;
  font: 11.5px/1.55 var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
  white-space: pre-wrap;
  word-break: break-all;
  animation: tail-typing var(--tw-duration, 0.8s) steps(40, end) both;
}
.script-card-tail .tail-pre.err {
  color: var(--danger, #ef4444);
}
@keyframes tail-typing {
  from {
    clip-path: inset(0 100% 0 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}
.why-label {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--surface-3, #161b22);
  font: 600 10px/1.4 var(--mono, monospace);
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
}
.script-card-tail .tail-pre {
  margin: 0;
  padding: 4px 0;
  font: 11.5px/1.55 var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
  white-space: pre-wrap;
  word-break: break-all;
  animation: tail-typing var(--tw-duration, 0.8s) steps(40, end) both;
}
.script-card-tail .tail-pre.err {
  color: var(--danger, #ef4444);
}
@keyframes tail-typing {
  from {
    clip-path: inset(0 100% 0 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
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
.done-summary-body :deep(strong) {
  font-weight: 600;
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
.done-summary-body :deep(.md-inline) {
  padding: 1px 5px;
  background: rgb(110 118 129 / 25%);
  border-radius: 4px;
  font: 12px var(--mono, monospace);
  color: var(--text-2, #c9d1d9);
}
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
