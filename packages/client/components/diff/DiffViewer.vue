<script setup lang="ts">
import { diffLines as diffLinesLib } from 'diff'
import { DEFAULT_HIGHLIGHT_HEAD, DEFAULT_HIGHLIGHT_TAIL } from './DiffViewer.constants'

interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
  oldLine?: number
  newLine?: number
}

/** 组件接收的 props 定义 */
const props = defineProps<{
  before: string
  after: string
  fileName: string
  changeType: 'added' | 'modified' | 'deleted'
}>()

/** 超高亮时保留头部行数（常量来源见 DiffViewer.constants） */
const HIGHLIGHT_HEAD = DEFAULT_HIGHLIGHT_HEAD
/** 超高亮时保留尾部行数（常量来源见 DiffViewer.constants） */
const HIGHLIGHT_TAIL = DEFAULT_HIGHLIGHT_TAIL
/** 触发"只高亮头尾"策略的行数阈值；超过时中段用 escapeHtml 降级，避免大文件卡顿 */
const HIGHLIGHT_THRESHOLD = 400
/** 差异视图单行高度（像素） */
const ROW_HEIGHT = 22
/** 虚拟滚动的缓冲区行数（上下各预留） */
const BUFFER = 20
let idleHandle: number | ReturnType<typeof setTimeout> | null = null

/** 变更前源码的 hljs 高亮 HTML 行；由 scheduleHighlight 异步填充 */
const beforeLines = ref<string[]>([])
/** 变更后源码的 hljs 高亮 HTML 行；由 scheduleHighlight 异步填充 */
const afterLines = ref<string[]>([])
/** diff 主体容器引用；虚拟滚动与视口高度测量均依赖此 ref */
const diffBodyRef = ref<HTMLElement | null>(null)
/** 当前滚动位置（像素）；由 onScroll 更新，visibleRange 计算依赖它 */
const scrollTop = ref(0)
/** 可视区域高度（像素） */
const viewportHeight = ref(600)

useResizeObserver(diffBodyRef, () => {
  if (diffBodyRef.value) viewportHeight.value = diffBodyRef.value.clientHeight
})

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
/** 虚拟滚动当前可见的行号范围 */
const visibleRange = computed(() => {
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - BUFFER)
  const end = Math.min(diffLines.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + BUFFER)
  return { start, end }
})
/** 当前可视窗口内的差异行（虚拟滚动实际渲染集合） */
const visibleLines = computed(() => diffLines.value.slice(visibleRange.value.start, visibleRange.value.end))
/** 虚拟滚动顶部占位高度 */
const spacerTop = computed(() => visibleRange.value.start * ROW_HEIGHT)
/** 虚拟滚动底部占位高度 */
const spacerBottom = computed(() => Math.max(0, diffLines.value.length - visibleRange.value.end) * ROW_HEIGHT)
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

watch(() => [props.before, props.after] as const, scheduleHighlight, { immediate: true })

// 用 vueuse useResizeObserver 替换手写 observer：
// 内部自动 in-scope 清理（组件卸载时 disconnect），省掉 onBeforeUnmount 分支
// [CONSTRAINT] target 传入 ref 对象本身（非 .value），vueuse 会 watch 引用变化后在 DOM 就绪时 observe
onMounted(() => {
  if (diffBodyRef.value) viewportHeight.value = diffBodyRef.value.clientHeight
})
onBeforeUnmount(() => {
  clearIdle()
})

/**
 * 将源码文本按行做 hljs 高亮，返回高亮后的 HTML 行数组
 * [WHY] 行数超过 HIGHLIGHT_THRESHOLD 时只高亮头尾，中段用 escapeHtml 降级：hljs 对大文件代价高
 * [CONSTRAINT] 返回的每项为 HTML 片段，调用方需用 v-html 渲染；行数与原文一致（split 后）
 * [CHANGE-IMPACT] 头尾行为 HIGHLIGHT_HEAD / HIGHLIGHT_TAIL，改这两个常量会影响超高亮策略分界
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
// LCS DP：O(N*M) 内存/时间。对齐质量远好于朴素滑动比较。
// ponytail: N*M > 4M 走 fallback（全删全增），防大文件卡死。
// 升级路径：换 Myers O((N+M)D)，但代码复杂 3 倍。

/**
 * 对比前后两份源码文本，产出逐行 diff 结果
 * [WHY] 依赖 diff 库的 diffLines 算法；LCS DP 保对齐质量，大文件走全删全增降级
 * [CONSTRAINT] 输入必须为行数组（外部已 split）；返回按原文顺序排列，同一行的 old/new 行号可能不等
 * @param a 变更前文本行数组
 * @param b 变更后文本行数组
 */
function computeDiff(a: string[], b: string[]): DiffLine[] {
  // [diffviewer-lcs-guard-v1] 报告 §4：文件头注释声称 N*M > 4M 走 fallback，但实现直接调 diffLinesLib。
  // 此处补齐：超阈值时按「全删 + 全增」输出，避免 LCS DP 在巨大文件上 O(N*M) 卡死主线程。
  const LCS_CELL_LIMIT = 4_000_000
  if (a.length * b.length > LCS_CELL_LIMIT) {
    const fallback: DiffLine[] = []
    for (let i = 0; i < a.length; i++) fallback.push({ type: 'del', text: a[i], oldLine: i + 1 })
    for (let i = 0; i < b.length; i++) fallback.push({ type: 'add', text: b[i], newLine: i + 1 })
    return fallback
  }
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
/**
 * 取消挂起的空闲回调
 * [CONSTRAINT] 幂等；requestIdleCallback 与 setTimeout 两条路径都正确清理（idleHandle 类型联合）
 * [WHY] 高亮是重活，用 requestIdleCallback 空闲时执行；快速切换文件时需取消上一轮避免覆盖
 */
function clearIdle() {
  if (idleHandle === null) return
  if (typeof idleHandle === 'number' && typeof cancelIdleCallback === 'function') cancelIdleCallback(idleHandle)
  else clearTimeout(idleHandle as ReturnType<typeof setTimeout>)
  idleHandle = null
}
/**
 * 调度一次异步高亮（下一帧空闲或 0ms 延迟执行）
 * [WHY] 高亮耗时随文件增大而线性增长，放空闲时段可避免阻塞首次渲染
 * [CONSTRAINT] 重复调用会先取消上一轮（clearIdle），避免旧高亮结果覆盖新内容
 * [CHANGE-IMPACT] watch props.before/after 时以 immediate 触发一次，首屏渲染依赖此路径
 */
function scheduleHighlight() {
  clearIdle()
  /** 空闲回调：读取最新 props 并刷新高亮结果；置 idleHandle 为 null 以标记"无挂起" */
  const run = () => {
    idleHandle = null
    beforeLines.value = highlightToLines(props.before)
    afterLines.value = highlightToLines(props.after)
  }
  if (typeof requestIdleCallback === 'function') idleHandle = requestIdleCallback(run)
  else idleHandle = setTimeout(run, 0)
}
/**
 * 从预高亮结果中取某行的 HTML；未命中时回落 escapeHtml
 * [WHY] 高亮是异步的，diff 结构先产出时 beforeLines/afterLines 可能还未填充，故需兜底
 * [CONSTRAINT] 按行号索引（1-based 转 0-based）；超出数组边界或类型不匹配时回落到原始文本转义
 */
function renderLine(line: DiffLine): string {
  if (line.type === 'add' && line.newLine !== undefined) return afterLines.value[line.newLine - 1] ?? escapeHtml(line.text)
  if (line.type === 'del' && line.oldLine !== undefined) return beforeLines.value[line.oldLine - 1] ?? escapeHtml(line.text)
  if (line.type === 'same') return afterLines.value[(line.newLine ?? 1) - 1] ?? escapeHtml(line.text)
  return escapeHtml(line.text)
}
/**
 * 记录滚动位置以驱动虚拟滚动
 * [CONSTRAINT] 事件绑定为 @scroll.passive，不可在内部 preventDefault（浏览器警告）
 * @param e 来自 diff-body 容器的 scroll 事件；e.target 即容器元素
 */
function onScroll(e: Event) {
  const el = e.target as HTMLElement
  scrollTop.value = el.scrollTop
}
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
  /* [ui-type-scale-v1] 辅助下限 11px（原 10px） */
  font-size: var(--font-11);
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

  overflow-x: auto; /* [diff-no-wrap-v1] 配合关折行：长行横向滚动 */
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

  /* [diff-no-wrap-v1] 关折行：虚拟滚动用固定 ROW_HEIGHT=22 计算 spacerTop/Bottom，
     原 white-space:pre-wrap 会让长行折为多行，spacer 与真实高度不自洽，
     表现为中段空白 / 丢行 / 滚不到底（报告 §1.3）。横向滚动由父容器提供。 */
  white-space: pre;
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
