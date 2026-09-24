<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { highlightToHtml } from '../../composables/useHljs'
import { diffLines as diffLinesLib } from 'diff'
import { DEFAULT_HIGHLIGHT_HEAD, DEFAULT_HIGHLIGHT_TAIL } from './DiffViewer.constants'

/** 组件接收的 props 定义 */
const props = defineProps<{
  before: string
  after: string
  fileName: string
  changeType: 'added' | 'modified' | 'deleted'
}>()

interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

// LCS DP：O(N*M) 内存/时间。对齐质量远好于朴素滑动比较。
// ponytail: N*M > 4M 走 fallback（全删全增），防大文件卡死。
// 升级路径：换 Myers O((N+M)D)，但代码复杂 3 倍。

/**
 * 执行 escape Html
 * @param s - s
 */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[ch] as string))
}
/** 高亮 */
const HIGHLIGHT_HEAD = DEFAULT_HIGHLIGHT_HEAD
/** 高亮 */
const HIGHLIGHT_TAIL = DEFAULT_HIGHLIGHT_TAIL
/** 高亮 */
const HIGHLIGHT_THRESHOLD = 400
/**
 * 执行 highlight To Lines
 * @param text - text
 */
function highlightToLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.length <= HIGHLIGHT_THRESHOLD) {
    try { return highlightToHtml(text).split('\n') }
    catch { return lines.map(escapeHtml) }
  }
  const headText = lines.slice(0, HIGHLIGHT_HEAD).join('\n')
  const tailText = lines.slice(-HIGHLIGHT_TAIL).join('\n')
  let headHtml: string[]
  let tailHtml: string[]
  try { headHtml = highlightToHtml(headText).split('\n') }
  catch { headHtml = lines.slice(0, HIGHLIGHT_HEAD).map(escapeHtml) }
  try { tailHtml = highlightToHtml(tailText).split('\n') }
  catch { tailHtml = lines.slice(-HIGHLIGHT_TAIL).map(escapeHtml) }
  const mid = lines.slice(HIGHLIGHT_HEAD, -HIGHLIGHT_TAIL).map(escapeHtml)
  return [...headHtml, ...mid, ...tailHtml]
}
/**
 * 计算 Diff
 * @param a - a
 * @param b - b
 */
function computeDiff(a: string[], b: string[]): DiffLine[] {
  const changes = diffLinesLib(a.join('\n'), b.join('\n'))
  const out: DiffLine[] = []
  let oldLine = 1
  let newLine = 1
  for (const ch of changes) {
    const text = ch.value.endsWith('\n') ? ch.value.slice(0, -1) : ch.value
    for (const line of text.split('\n')) {
      if (ch.added) out.push({ type: 'add', text: line, newLine: newLine++ })
      else if (ch.removed) out.push({ type: 'del', text: line, oldLine: oldLine++ })
      else out.push({ type: 'same', text: line, oldLine: oldLine++, newLine: newLine++ })
    }
  }
  return out
}

/** 行集合 */
const beforeLines = ref<string[]>([])
/** 行集合 */
const afterLines = ref<string[]>([])
let idleHandle: number | ReturnType<typeof setTimeout> | null = null
/**
 * 清空 Idle
 */
function clearIdle() {
  if (idleHandle === null) return
  if (typeof idleHandle === 'number' && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle)
  else clearTimeout(idleHandle as ReturnType<typeof setTimeout>)
  idleHandle = null
}
/**
 * 执行 schedule Highlight
 */
function scheduleHighlight() {
  clearIdle()
  /** 运行 */
  const run = () => {
    idleHandle = null
    beforeLines.value = highlightToLines(props.before)
    afterLines.value = highlightToLines(props.after)
  }
  if (typeof requestIdleCallback === 'function') idleHandle = requestIdleCallback(run)
  else idleHandle = setTimeout(run, 0)
}
watch(() => [props.before, props.after] as const, scheduleHighlight, { immediate: true })

/** 差异行集合 */
const diffLines = computed((): DiffLine[] => {
  if (props.changeType === 'added') {
    return props.after.split('\n').map((line, i) => ({ type: 'add' as const, text: line, newLine: i + 1 }))
  }
  if (props.changeType === 'deleted') {
    return props.before.split('\n').map((line, i) => ({ type: 'del' as const, text: line, oldLine: i + 1 }))
  }
  return computeDiff(props.before.split('\n'), props.after.split('\n'))
})

/**
 * 渲染 Line
 * @param line - line
 */
function renderLine(line: DiffLine): string {
  if (line.type === 'add' && line.newLine !== undefined) return afterLines.value[line.newLine - 1] ?? escapeHtml(line.text)
  if (line.type === 'del' && line.oldLine !== undefined) return beforeLines.value[line.oldLine - 1] ?? escapeHtml(line.text)
  if (line.type === 'same') return afterLines.value[(line.newLine ?? 1) - 1] ?? escapeHtml(line.text)
  return escapeHtml(line.text)
}

/** 差异视图单行高度（像素） */
const ROW_HEIGHT = 22
/** 虚拟滚动的缓冲区行数（上下各预留） */
const BUFFER = 20
/** 差异引用 */
const diffBodyRef = ref<HTMLElement | null>(null)
/** 滚动 */
const scrollTop = ref(0)
/** 可视区域高度（像素） */
const viewportHeight = ref(600)
/** 虚拟滚动当前可见的行号范围 */
const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - BUFFER)
  const end = Math.min(diffLines.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + BUFFER)
  return { start, end }
})
/** 行集合 */
const visibleLines = computed(() => diffLines.value.slice(visibleRange.value.start, visibleRange.value.end))
/** 虚拟滚动顶部占位高度 */
const spacerTop = computed(() => visibleRange.value.start * ROW_HEIGHT)
/** 虚拟滚动底部占位高度 */
const spacerBottom = computed(() => Math.max(0, diffLines.value.length - visibleRange.value.end) * ROW_HEIGHT)
/**
 * 响应 Scroll
 * @param e - e
 */
function onScroll(e: Event) {
  const el = e.target as HTMLElement
  scrollTop.value = el.scrollTop
}
let resizeObs: ResizeObserver | null = null
onMounted(() => {
  if (!diffBodyRef.value) return
  viewportHeight.value = diffBodyRef.value.clientHeight
  if (typeof ResizeObserver !== 'undefined') {
    resizeObs = new ResizeObserver(() => {
      if (diffBodyRef.value) viewportHeight.value = diffBodyRef.value.clientHeight
    })
    resizeObs.observe(diffBodyRef.value)
  }
})
onBeforeUnmount(() => {
  clearIdle()
  if (resizeObs) { resizeObs.disconnect(); resizeObs = null }
})

/** 统计信息 */
const stats = computed(() => {
  let add = 0
  let del = 0
  for (const l of diffLines.value) {
    if (l.type === 'add') add++
    else if (l.type === 'del') del++
  }
  return { add, del }
})
</script>

<template>
  <div class="diff-viewer">
    <div class="diff-header">
      <span class="diff-filename">{{ fileName }}</span>
      <span class="diff-badge" :class="changeType">{{ changeType.toUpperCase() }}</span>
      <span class="diff-stats">
        <span v-if="stats.add" class="stat-add">+{{ stats.add }}</span>
        <span v-if="stats.del" class="stat-del">-{{ stats.del }}</span>
      </span>
    </div>
    <div ref="diffBodyRef" class="diff-body" @scroll.passive="onScroll">
      <template v-if="diffLines.length">
        <div :style="{ height: `${spacerTop}px` }" />
        <div
          v-for="(line, i) in visibleLines"
          :key="visibleRange.start + i"
          class="diff-line"
          :class="line.type"
        >
          <span class="line-num new">{{ line.newLine ?? '' }}</span>
          <span class="line-prefix">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
          <pre class="line-text" v-html="renderLine(line)" />
        </div>
        <div :style="{ height: `${spacerBottom}px` }" />
      </template>
      <div v-else class="diff-empty">
        无内容变更
      </div>
    </div>
  </div>
</template>

<style scoped>
.diff-viewer {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: var(--radius, 8px);
  overflow: hidden;
  background: var(--surface);

  display: flex;
  flex-direction: column;
  min-height: 0;
}

.diff-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-2, #f6f8fa);
  border-bottom: 1px solid var(--border, #e5e7eb);
  font-size: 13px;
  font-weight: 600;
}
.diff-filename {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--mono, monospace);
  font-size: 12px;
  font-weight: 500;
  color: var(--text, #1f2d3d);
}
.diff-badge {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-4);
  font-weight: 700;
  text-transform: uppercase;
  flex-shrink: 0;
}
.diff-badge.added {
  background: var(--success-bg);
  color: var(--success);
}
.diff-badge.modified {
  background: var(--warning-bg);
  color: var(--warning);
}
.diff-badge.deleted {
  background: var(--danger-bg);
  color: var(--danger);
}

.diff-stats {
  margin-left: auto;
  display: flex;
  gap: 8px;
  font-family: var(--mono, monospace);
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.stat-add {
  color: var(--success);
}
.stat-del {
  color: var(--danger);
}

.diff-body {
  flex: 1 1 auto;
  min-height: 160px;
  max-height: none;

  overflow-x: hidden;
  overflow-y: auto;
  font: 12px/1.6 var(--mono, monospace);
  background: var(--surface);
}
.diff-line {
  display: flex;
  min-height: 22px;
  transition: background 0.08s;
}
.diff-line:hover {
  background: var(--surface-2);
  filter: brightness(0.98);
}

.line-num {
  width: 56px;
  flex-shrink: 0;
  text-align: right;
  padding: 0 10px;
  color: var(--text-3);
  user-select: none;
  font-variant-numeric: tabular-nums;
  background: var(--surface-2);
  border-right: 1px solid var(--border);
  font-size: 11.5px;
  line-height: 22px;
}

.line-prefix {
  width: 20px;
  flex-shrink: 0;
  text-align: center;
  font-weight: 700;
  user-select: none;
  color: var(--text-3);
  line-height: 22px;
}

.line-text {
  margin: 0;
  padding: 0 14px;

  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
  flex: 1;
  min-width: 0;
  color: var(--text, #1f2d3d);
  line-height: 22px;
}

.diff-line.add {
  background: rgb(16 185 129 / 20%);
  border-left: 3px solid var(--success);
}
.diff-line.add:hover {
  background: rgb(16 185 129 / 30%);
}
.diff-line.add .line-prefix {
  color: var(--success);
}
.diff-line.add .line-num {
  background: rgb(16 185 129 / 28%);
}

.diff-line.del {
  background: rgb(239 68 68 / 20%);
  border-left: 3px solid var(--danger);
}
.diff-line.del:hover {
  background: rgb(239 68 68 / 30%);
}
.diff-line.del .line-prefix {
  color: var(--danger);
}
.diff-line.del .line-num {
  background: rgb(239 68 68 / 28%);
}

.diff-line.same {
  border-left: 3px solid transparent;
}
.diff-body :deep(.hljs-keyword),
.diff-body :deep(.hljs-literal) {
  color: #569cd6;
}
.diff-body :deep(.hljs-string) {
  color: #ce9178;
}
.diff-body :deep(.hljs-number) {
  color: #b5cea8;
}
.diff-body :deep(.hljs-comment) {
  color: #6a9955;
  font-style: italic;
}
.diff-body :deep(.hljs-function),
.diff-body :deep(.hljs-title) {
  color: #dcdcaa;
}
.diff-body :deep(.hljs-variable),
.diff-body :deep(.hljs-params),
.diff-body :deep(.hljs-attr) {
  color: #9cdcfe;
}
.diff-body :deep(.hljs-built_in),
.diff-body :deep(.hljs-type) {
  color: #4ec9b0;
}
</style>
