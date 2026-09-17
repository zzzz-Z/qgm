<script setup lang="ts">
import { defineOptions } from 'vue'
defineOptions({ name: 'DiffViewer' })
import { computed } from 'vue'
import * as hljsNs from 'highlight.js/lib/core'
const hljs: any = (hljsNs as any).default ?? hljsNs
import * as javascriptNs from 'highlight.js/lib/languages/javascript'
const javascript: any = (javascriptNs as any).default ?? javascriptNs
import * as typescriptNs from 'highlight.js/lib/languages/typescript'
const typescript: any = (typescriptNs as any).default ?? typescriptNs

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)

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
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    '\'': '&#39;',
  }[ch] as string))
}
function renderCode(text: string): string {
  if (!text) return ''
  try {
    return hljs.highlightAuto(text, ['javascript', 'typescript']).value
  } catch {
    return escapeHtml(text)
  }
}
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const N = a.length
  const M = b.length
  if (N * M > 4_000_000) {
    const out: DiffLine[] = []
    a.forEach((t, i) => out.push({ type: 'del', text: t, oldLine: i + 1 }))
    b.forEach((t, i) => out.push({ type: 'add', text: t, newLine: i + 1 }))
    return out
  }
  const dp: number[][] = Array.from({ length: N + 1 }, () => new Array(M + 1).fill(0))
  for (let i = N - 1; i >= 0; i--) {
    for (let j = M - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0; let j = 0
  while (i < N && j < M) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i], oldLine: i + 1, newLine: j + 1 })
      i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i], oldLine: i + 1 })
      i++
    } else {
      out.push({ type: 'add', text: b[j], newLine: j + 1 })
      j++
    }
  }
  while (i < N) { out.push({ type: 'del', text: a[i], oldLine: i + 1 }); i++ }
  while (j < M) { out.push({ type: 'add', text: b[j], newLine: j + 1 }); j++ }
  return out
}

const diffLines = computed((): DiffLine[] => {
  if (props.changeType === 'added') {
    return props.after.split('\n').map((line, i) => ({ type: 'add' as const, text: line, newLine: i + 1 }))
  }
  if (props.changeType === 'deleted') {
    return props.before.split('\n').map((line, i) => ({ type: 'del' as const, text: line, oldLine: i + 1 }))
  }
  return lcsDiff(props.before.split('\n'), props.after.split('\n'))
})

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
    <div class="diff-body">
      <div v-for="(line, i) in diffLines" :key="i" class="diff-line" :class="line.type">
        <!-- [5.4] 只显 newLine，坐标统一到 after 系统，与 prompt 一致 -->
        <span class="line-num new">{{ line.newLine ?? '' }}</span>
        <span class="line-prefix">{{ line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ' }}</span>
        <pre class="line-text" v-html="renderCode(line.text)" />
      </div>
      <div v-if="diffLines.length === 0" class="diff-empty">
        无内容变更
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ponytail: 用 GitHub 风格配色，add/del 用绿/红浅底 + 左侧 3px 色条 */
.diff-viewer {
  border: 1px solid var(--border, #e5e7eb);
  border-radius: var(--radius, 8px);
  overflow: hidden;
  background: var(--surface);
  /* 自适应：撑满父容器剩余高度 */
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* ---------- Header ---------- */
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
  border-radius: 4px;
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

/* ---------- 统计 ---------- */
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

/* ---------- Body ---------- */
.diff-body {
  /* 撑满剩余空间，最小 160px 保底 */
  flex: 1 1 auto;
  min-height: 160px;
  max-height: none;
  /* no-h-scroll */
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

/* 行号列 */
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

/* 前缀 + / - */
.line-prefix {
  width: 20px;
  flex-shrink: 0;
  text-align: center;
  font-weight: 700;
  user-select: none;
  color: var(--text-3);
  line-height: 22px;
}

/* 文本：pre 保留空白，长行水平滚动 */
.line-text {
  margin: 0;
  padding: 0 14px;
  /* no-h-scroll */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-all;
  flex: 1;
  min-width: 0;
  color: var(--text, #1f2d3d);
  line-height: 22px;
}

/* 新增行 */
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

/* 删除行 */
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

/* same 行保持默认，不加左边框 */
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

/* ---------- 空状态 ---------- */
.diff-empty {
  padding: 40px 16px;
  text-align: center;
  color: var(--text-3, #9ca3af);
  font-style: italic;
  font-size: 12px;
}
</style>
