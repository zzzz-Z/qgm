<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useTraceLog } from '../../composables/ui/useTraceLog'

defineOptions({ name: 'TracePanel' })
const PRE_LIMIT = 1500
const expandedPre = ref<Set<number>>(new Set())
function preKey(id: number, field: string): number {
  let h = 0
  const s = `${id}:${field}`
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0
  return h
}
function trimPre(text: string, id: number, field: string): string {
  if (!text) return ''
  const k = preKey(id, field)
  if (text.length <= PRE_LIMIT || expandedPre.value.has(k)) return text
  return `${text.slice(0, PRE_LIMIT)}\n… 剩余 ${text.length - PRE_LIMIT} 字符（点击展开）`
}
function togglePre(id: number, field: string): void {
  const k = preKey(id, field)
  const s = new Set(expandedPre.value)
  if (s.has(k)) s.delete(k); else s.add(k)
  expandedPre.value = s
}
function preTruncated(text: string, id: number, field: string): boolean {
  if (!text) return false
  return text.length > PRE_LIMIT && !expandedPre.value.has(preKey(id, field))
}

const { entries, removeTrace, clearTraces, MAX_ENTRIES } = useTraceLog()
const expanded = ref<Set<number>>(new Set())
// [default-expand-first] 首条进入自动展开；用户手动操作过则不覆盖
watch(
  () => entries.value[0]?.id,
  (id) => {
    if (id === undefined) return
    if (expanded.value.size > 0) return
    expanded.value = new Set([id])
  },
  { immediate: true },
)
/** 折叠的循环分组（key = loopId） */
const collapsedLoops = ref<Set<string>>(new Set())
const filter = ref<'all' | 'success' | 'fail'>('all')

const filtered = computed(() => {
  // 只保留脚本执行记录（kind === 'run'）；展示所有
  const runs = entries.value.filter(e => e.kind === 'run')
  if (filter.value === 'success') return runs.filter(e => e.payload.ok === true)
  if (filter.value === 'fail') return runs.filter(e => e.payload.ok === false)
  return runs
})

interface TraceGroup {
  key: string
  isLoop: boolean
  loopId?: string
  goal?: string
  maxRound: number
  items: typeof entries.value
}

/**
 * 按 loopId 聚合（v6 §3.2 LoopEntry）：带 loopId 的记录归入循环折叠组，其余独立成组。
 * 顺序遵循 filtered（新→旧），循环组在其最新一条记录的位置出现。
 */
const groups = computed<TraceGroup[]>(() => {
  const out: TraceGroup[] = []
  const loopIndex = new Map<string, TraceGroup>()
  for (const e of filtered.value) {
    const lid = e.payload.loopId
    if (!lid) {
      out.push({ key: `s_${e.id}`, isLoop: false, maxRound: 0, items: [e] })
      continue
    }
    let g = loopIndex.get(lid)
    if (!g) {
      g = { key: `l_${lid}`, isLoop: true, loopId: lid, maxRound: 0, items: [] }
      loopIndex.set(lid, g)
      out.push(g)
    }
    g.items.push(e)
    g.maxRound = Math.max(g.maxRound, Number(e.payload.loopRound) || 0)
    // 循环开始记录（kind=loop 且 round=0）的 prompt 即目标
    if (!g.goal && e.kind === 'loop' && e.payload.prompt) g.goal = e.payload.prompt
  }
  return out
})
const expandedFiles = ref<Set<string>>(new Set())
const fileContents = ref<Map<string, string>>(new Map())
const fileLoading = ref<Set<string>>(new Set())
async function toggleFilePreview(path: string) {
  const s = new Set(expandedFiles.value)
  if (s.has(path)) {
    s.delete(path)
    expandedFiles.value = s
    return
  }
  s.add(path)
  expandedFiles.value = s
  if (fileContents.value.has(path)) return
  const l = new Set(fileLoading.value)
  l.add(path)
  fileLoading.value = l
  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: [path] }),
    })
    const data = await res.json()
    const f = data.files && data.files[0]
    const next = new Map(fileContents.value)
    next.set(path, f?.error ? `[错误] ${f.error}` : (f?.content || ''))
    fileContents.value = next
  } catch (e) {
    const next = new Map(fileContents.value)
    next.set(path, `[读取失败] ${String(e)}`)
    fileContents.value = next
  } finally {
    const l = new Set(fileLoading.value)
    l.delete(path)
    fileLoading.value = l
  }
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
const PAGE_SIZE = ref(20)
const page = ref(1)
// 真分页（不累积）
const visibleGroups = computed(() => {
  const start = (page.value - 1) * PAGE_SIZE.value
  return groups.value.slice(start, start + PAGE_SIZE.value)
})
const totalPages = computed(() => Math.max(1, Math.ceil(groups.value.length / PAGE_SIZE.value)))
const hasMore = computed(() => page.value < totalPages.value)
watch(filter, () => { page.value = 1 })

function toggleLoop(loopId: string) {
  const s = new Set(collapsedLoops.value)
  if (s.has(loopId)) s.delete(loopId)
  else s.add(loopId)
  collapsedLoops.value = s
}

function displayTitle(e: typeof entries.value[0]): string {
  // 1. payload.desc 优先
  const d = String(e.payload?.desc || '').trim()
  if (d) return d
  // 2. 从 payload.script 提取
  const src = String(e.payload?.script || '')
  if (src) {
    // 2a. @desc 注释
    const dm = src.match(/^[ \t]*(?:\/\/|#)[ \t]*@desc[ \t]*:[ \t]*(\S.*)$/m)
    if (dm && dm[1].trim()) return dm[1].trim().slice(0, 100)
    // 2b. shebang 后第一条注释
    const lines = src.split('\n')
    let seenShebang = false
    for (const raw of lines) {
      const t = raw.trim()
      if (!t) continue
      if (t.startsWith('#!')) { seenShebang = true; continue }
      if (t.startsWith('//')) {
        const c = t.slice(2).trim()
        if (c && !c.startsWith('@')) return c.slice(0, 100)
        continue
      }
      if (t.startsWith('#')) {
        const c = t.slice(1).trim()
        if (c && !c.startsWith('@')) return c.slice(0, 100)
        continue
      }
      // 非注释行即止（shebang 后第一条非注释不算标题）
      if (seenShebang) break
    }
  }
  // 3. 兜底
  return e.summary
}

function kindLabel(kind: string): string {
  if (kind === 'ask') return '💬'
  if (kind === 'run') return '▶'
  if (kind === 'script') return '📥'
  if (kind === 'loop') return '⟳'
  return '·'
}

const counts = computed(() => {
  let success = 0; let fail = 0
  for (const e of entries.value) {
    if (e.kind !== 'run') continue
    if (e.payload.ok === true) success++
    else if (e.payload.ok === false) fail++
  }
  return { success, fail, total: success + fail }
})

function toggle(id: number) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t) } catch { }
}

function confirmClear() {
  if (!entries.value.length) return
  clearTraces()
}
</script>

<template>
  <div class="trace-panel">
    <header class="trace-bar">
      <div class="trace-title-row">
        <span class="trace-title">会话记录</span>
        <span class="trace-total">{{ entries.length }} / {{ MAX_ENTRIES }}</span>
        <span class="trace-breakdown">
          <span class="t-pill run">成功 {{ counts.success }}</span>
          <span class="t-pill fail">失败 {{ counts.fail }}</span>
        </span>
      </div>
      <div class="trace-actions">
        <div class="trace-tabs">
          <button v-tooltip="'显示全部脚本执行记录'" :class="{ active: filter === 'all' }" @click="filter = 'all'">
            全部
          </button>
          <button v-tooltip="'只看成功的执行'" :class="{ active: filter === 'success' }" @click="filter = 'success'">
            成功
          </button>
          <button v-tooltip="'只看失败的执行'" :class="{ active: filter === 'fail' }" @click="filter = 'fail'">
            失败
          </button>
        </div>
        <button v-tooltip="entries.length ? `清空全部 ${entries.length} 条记录` : '没有可清空的记录'" class="trace-clear" :disabled="!entries.length" @click="confirmClear">
          清空
        </button>
      </div>
    </header>
    <div class="trace-list">
      <div v-if="!filtered.length" class="trace-empty">
        <div class="trace-empty-icon">
          📓
        </div>
        <div class="trace-empty-title">
          还没有记录
        </div>
        <div class="trace-empty-hint">
          运行脚本后自动记录，按成功/失败分类
        </div>
      </div>
      <div v-for="g in visibleGroups" :key="g.key" class="trace-group">
        <!-- 循环分组头（v6 §3.2 LoopEntry） -->
        <div v-if="g.isLoop" class="loop-group-head" @click="g.loopId && toggleLoop(g.loopId)">
          <span class="loop-group-caret" :class="{ open: g.loopId ? !collapsedLoops.has(g.loopId) : false }">▾</span>
          <span class="loop-group-badge">⟳ 循环</span>
          <span class="loop-group-goal" :title="g.goal">{{ g.goal || g.loopId }}</span>
          <span class="loop-group-meta">{{ g.items.length }} 条决策 · {{ g.maxRound }} 轮</span>
        </div>
        <template v-if="!g.isLoop || (g.loopId && !collapsedLoops.has(g.loopId))">
          <div v-for="e in g.items" :key="e.id" class="trace-card" :class="[e.kind, { err: e.kind === 'run' && e.payload.ok === false }]">
            <div class="trace-head" @click="toggle(e.id)">
              <span class="trace-badge" :class="e.kind">{{ kindLabel(e.kind) }}</span>
              <span v-if="e.payload.loopRound" class="round-pill">R{{ e.payload.loopRound }}</span>
              <span class="trace-summary">{{ displayTitle(e) }}</span>
              <span class="trace-time">{{ fmtTime(e.ts) }}</span>
              <button v-tooltip="'删除这条记录'" class="trace-del" aria-label="删除记录" @click.stop="removeTrace(e.id)">
                ×
              </button>
              <span class="trace-caret" :class="{ open: expanded.has(e.id) }">▾</span>
            </div>
            <div v-if="expanded.has(e.id)" class="trace-body">
              <template v-if="e.kind === 'ask'">
                <div v-if="e.payload.question" class="trace-section">
                  <div class="trace-label">
                    <span>问题</span><button class="trace-mini" @click="copyText(e.payload.question || '')">
                      复制
                    </button>
                  </div>
                  <pre class="trace-pre" :style="{ cursor: preTruncated(e.payload.question || '', e.id, 'question') ? 'pointer' : 'auto' }" @click="preTruncated(e.payload.question || '', e.id, 'question') && togglePre(e.id, 'question')">{{ trimPre(e.payload.question || '', e.id, 'question') }}</pre>
                </div>
                <div v-if="e.payload.files && e.payload.files.length" class="trace-section">
                  <div class="trace-label">
                    <span>附加文件（{{ e.payload.files.length }}）</span>
                  </div>
                  <ul class="trace-files">
                    <li v-for="p in e.payload.files" :key="p">
                      {{ p }}
                    </li>
                  </ul>
                </div>
                <div v-if="e.payload.prompt" class="trace-section">
                  <div class="trace-label">
                    <span>完整 prompt</span><button class="trace-mini" @click="copyText(e.payload.prompt || '')">
                      复制
                    </button>
                  </div>
                  <pre class="trace-pre" :style="{ cursor: preTruncated(e.payload.prompt || '', e.id, 'prompt') ? 'pointer' : 'auto' }" @click="preTruncated(e.payload.prompt || '', e.id, 'prompt') && togglePre(e.id, 'prompt')">{{ trimPre(e.payload.prompt || '', e.id, 'prompt') }}</pre>
                </div>
              </template>
              <template v-else>
                <div v-if="e.payload.script" class="trace-section">
                  <div class="trace-label">
                    <span>脚本</span><button class="trace-mini" @click="copyText(e.payload.script || '')">
                      复制
                    </button>
                  </div>
                  <pre class="trace-pre" :style="{ cursor: preTruncated(e.payload.script || '', e.id, 'script') ? 'pointer' : 'auto' }" @click="preTruncated(e.payload.script || '', e.id, 'script') && togglePre(e.id, 'script')">{{ trimPre(e.payload.script || '', e.id, 'script') }}</pre>
                </div>
                <div v-if="e.payload.changes && e.payload.changes.length" class="trace-section">
                  <div class="trace-label">
                    <span>变更（{{ e.payload.changes.length }}）</span>
                  </div>
                  <ul class="trace-changes">
                    <li v-for="c in e.payload.changes" :key="c.path">
                      <div class="chg-row" :class="{ 'is-open': expandedFiles.has(c.path) }" @click="toggleFilePreview(c.path)">
                        <span class="chg" :class="c.type">{{ c.type.charAt(0).toUpperCase() }}</span>
                        <span class="chg-path">{{ c.path }}</span>
                        <span class="chg-caret">▾</span>
                      </div>
                      <div v-if="expandedFiles.has(c.path)" class="chg-preview">
                        <div v-if="fileLoading.has(c.path)" class="chg-loading">
                          加载中…
                        </div>
                        <pre v-else class="chg-content">{{ fileContents.get(c.path) || '(空文件)' }}</pre>
                      </div>
                    </li>
                  </ul>
                </div>
                <div v-if="e.payload.stdout" class="trace-section">
                  <div class="trace-label">
                    <span>stdout</span><button class="trace-mini" @click="copyText(e.payload.stdout || '')">
                      复制
                    </button>
                  </div>
                  <pre class="trace-pre" :style="{ cursor: preTruncated(e.payload.stdout || '', e.id, 'stdout') ? 'pointer' : 'auto' }" @click="preTruncated(e.payload.stdout || '', e.id, 'stdout') && togglePre(e.id, 'stdout')">{{ trimPre(e.payload.stdout || '', e.id, 'stdout') }}</pre>
                </div>
                <div v-if="e.payload.stderr" class="trace-section">
                  <div class="trace-label">
                    <span>stderr</span><button class="trace-mini" @click="copyText(e.payload.stderr || '')">
                      复制
                    </button>
                  </div>
                  <pre class="trace-pre err" :style="{ cursor: preTruncated(e.payload.stderr || '', e.id, 'stderr') ? 'pointer' : 'auto' }" @click="preTruncated(e.payload.stderr || '', e.id, 'stderr') && togglePre(e.id, 'stderr')">{{ trimPre(e.payload.stderr || '', e.id, 'stderr') }}</pre>
                </div>
              </template>
            </div>
            <!-- [show-final-prompt] 最终发出的完整提示词（含自动匹配 skill） -->
            <div v-if="e.payload.prompt" class="trace-section">
              <div class="trace-label">
                <span>最终提示词</span>
                <button class="trace-mini" @click="copyText(e.payload.prompt || '')">
                  复制
                </button>
              </div>
              <pre
                class="trace-pre"
                :style="{ cursor: preTruncated(e.payload.prompt || '', e.id, 'prompt') ? 'pointer' : 'auto' }"
                @click="preTruncated(e.payload.prompt || '', e.id, 'prompt') && togglePre(e.id, 'prompt')"
              >{{ trimPre(e.payload.prompt || '', e.id, 'prompt') }}</pre>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
  <div v-if="groups.length" class="trace-pager">
    <!-- [fix-pager-ui] 页码导航 -->
    <span class="trace-pager-info">共 {{ groups.length }} 条</span>
    <button v-tooltip="'首页'" class="trace-page-btn" :disabled="page === 1" @click="page = 1">
      «
    </button>
    <button v-tooltip="'上一页'" class="trace-page-btn" :disabled="page === 1" @click="page--">
      ‹
    </button>
    <span class="trace-page-num">{{ page }} / {{ totalPages }}</span>
    <button v-tooltip="'下一页'" class="trace-page-btn" :disabled="!hasMore" @click="page++">
      ›
    </button>
    <button v-tooltip="'末页'" class="trace-page-btn" :disabled="!hasMore" @click="page = totalPages">
      »
    </button>
    <select v-model.number="PAGE_SIZE" class="trace-pager-size" @change="page = 1">
      <option v-for="n in PAGE_SIZE_OPTIONS" :key="n" :value="n">
        {{ n }}/页
      </option>
    </select>
  </div>
</template>

<style scoped lang="scss">
.trace-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
}
.trace-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
  row-gap: 6px;
}
.trace-title-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.trace-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.trace-total {
  font: 11px var(--mono);
  color: var(--text-3);
}
.trace-breakdown {
  display: flex;
  gap: 6px;
}
.t-pill {
  padding: 1px 8px;
  border-radius: var(--radius-10);
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.t-pill.ask {
  background: var(--primary-bg);
  color: var(--primary);
}
.t-pill.run {
  background: var(--success-bg);
  color: var(--success);
}
.t-pill.fail {
  background: var(--danger-bg);
  color: var(--danger);
}
.t-pill.loop {
  background: var(--warning-bg, rgba(230, 162, 60, 0.12));
  color: var(--warning, #e6a23c);
}
.trace-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.trace-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
}
.trace-tabs button {
  padding: 3px 10px;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  cursor: pointer;
}
.trace-tabs button.active {
  background: var(--primary-bg);
  color: var(--primary);
  font-weight: 600;
}
.trace-clear {
  padding: 4px 12px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
}
.trace-clear:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-bg);
}
.trace-clear:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.trace-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 12px 16px;
  contain: layout style paint;
}
.trace-list::-webkit-scrollbar {
  width: 8px;
}
.trace-list::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: var(--radius-4);
}
.trace-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 60px 20px;
  color: var(--text-3);
}
.trace-empty-icon {
  font-size: 32px;
  opacity: 0.4;
}
.trace-empty-title {
  font-size: 13px;
  color: var(--text-2);
  font-weight: 500;
}
.trace-empty-hint {
  font-size: 11px;
  opacity: 0.8;
}
.trace-card {
  content-visibility: auto;
  contain-intrinsic-size: auto 80px;
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  background: var(--surface);
  margin-top: 8px;
  overflow: hidden;
}
.trace-card.ask {
  border-left: 3px solid var(--primary);
}
.trace-card.run {
  border-left: 3px solid var(--success);
}
.trace-card.run.err {
  border-left-color: var(--danger);
}
.trace-card.script {
  border-left: 3px solid var(--primary);
}
.trace-card.loop {
  border-left: 3px solid var(--warning, #e6a23c);
}
.trace-badge.script {
  background: var(--primary-bg);
  color: var(--primary);
}
.trace-badge.loop {
  background: var(--warning-bg, rgba(230, 162, 60, 0.12));
  color: var(--warning, #e6a23c);
}
.round-pill {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius-8);
  background: var(--surface-2);
  border: 1px solid var(--border-2);
  font-size: 10px;
  font-weight: 600;
  color: var(--text-2);
  font-variant-numeric: tabular-nums;
}
.trace-group + .trace-group {
  margin-top: 10px;
}
.loop-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  background: var(--surface-2);
  cursor: pointer;
  user-select: none;
}
.loop-group-head:hover {
  border-color: var(--warning, #e6a23c);
}
.loop-group-caret {
  font-size: 10px;
  color: var(--text-3);
  transition: transform 0.15s;
}
.loop-group-caret.open {
  transform: rotate(0deg);
}
.loop-group-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-4);
  font-size: 10px;
  font-weight: 700;
  background: var(--warning-bg, rgba(230, 162, 60, 0.12));
  color: var(--warning, #e6a23c);
}
.loop-group-goal {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.loop-group-meta {
  flex-shrink: 0;
  font: 10px var(--mono);
  color: var(--text-3);
}
.loop-group-head + template + .trace-card,
.trace-group .trace-card {
  margin-top: 6px;
}
.trace-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  cursor: pointer;
  transition: background 0.1s;
}
.trace-head:hover {
  background: var(--surface-2);
}
.trace-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: var(--radius-4);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
}
.trace-badge.ask {
  background: var(--primary-bg);
  color: var(--primary);
}
.trace-badge.run {
  background: var(--success-bg);
  color: var(--success);
}
.trace-summary {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.trace-time {
  flex-shrink: 0;
  font: 11px var(--mono);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.trace-del {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition: 0.12s;
  font-size: 14px;
  line-height: 1;
}
.trace-head:hover .trace-del {
  opacity: 1;
}
.trace-del:hover {
  color: var(--danger);
  background: var(--danger-bg);
}
.trace-caret {
  flex-shrink: 0;
  color: var(--text-3);
  font-size: 10px;
  transition: transform 0.15s;
}
.trace-caret.open {
  transform: rotate(180deg);
}
.trace-body {
  border-top: 1px solid var(--border);
  padding: 8px 12px 12px;
  background: var(--surface-2);
}
.trace-section + .trace-section {
  margin-top: 10px;
}
.trace-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  margin-bottom: 4px;
}
.trace-mini {
  padding: 1px 8px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-4);
  background: var(--surface);
  color: var(--text-2);
  font-size: 10px;
  cursor: pointer;
}
.trace-mini:hover {
  border-color: var(--primary);
  color: var(--primary);
}
.trace-pre {
  margin: 0;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-6);
  font: 11px/1.55 var(--mono);
  color: var(--text);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}
.trace-pre.err {
  color: var(--danger);
}
.trace-files,
.trace-changes {
  margin: 0;
  padding: 6px 10px;
  list-style: none;
  font: 11px/1.6 var(--mono);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-6);
  max-height: 200px;
  overflow: auto;
}
.trace-files li,
.trace-changes li {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-2);
}

.trace-pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.trace-pager-info {
  font-size: 11px;
  color: var(--text-3);
  margin-right: 6px;
  font-variant-numeric: tabular-nums;
}
.trace-page-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: 0.12s;
}
.trace-page-btn:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
  background: var(--primary-bg);
}
.trace-page-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.trace-page-num {
  font: 12px var(--mono, monospace);
  color: var(--text-2);
  padding: 0 8px;
  min-width: 48px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.trace-pager-size {
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-6);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  outline: none;
  margin-left: 6px;
}
.trace-pager-size:focus {
  border-color: var(--primary);
}
</style>
<!-- tooltip-audit -->
