<script setup lang="ts">
defineOptions({ name: 'TracePanel' })
import { computed, ref } from 'vue'
import { useTraceLog } from '../composables/useTraceLog'

const { entries, removeTrace, clearTraces, MAX_ENTRIES } = useTraceLog()
const expanded = ref<Set<number>>(new Set())
const filter = ref<'all' | 'ask' | 'run'>('all')

const filtered = computed(() => {
  if (filter.value === 'all') return entries.value
  return entries.value.filter(e => e.kind === filter.value)
})

const counts = computed(() => {
  let ask = 0; let run = 0
  for (const e of entries.value) {
    if (e.kind === 'ask') ask++
    else if (e.kind === 'run') run++
  }
  return { ask, run, total: entries.value.length }
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
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

async function copyText(t: string) {
  try { await navigator.clipboard.writeText(t) } catch { }
}

function confirmClear() {
  if (!entries.value.length) return
  if (!window.confirm(`清空所有 ${entries.value.length} 条记录？`)) return
  clearTraces()
}
</script>

<template>
  <div class="trace-panel">
    <header class="trace-bar">
      <div class="trace-title-row">
        <span class="trace-title">会话记录</span>
        <span class="trace-total">{{ counts.total }} / {{ MAX_ENTRIES }}</span>
        <span class="trace-breakdown">
          <span class="t-pill ask">问 AI {{ counts.ask }}</span>
          <span class="t-pill run">运行 {{ counts.run }}</span>
        </span>
      </div>
      <div class="trace-actions">
        <div class="trace-tabs">
          <button v-tooltip="'显示全部记录'" :class="{ active: filter === 'all' }" @click="filter = 'all'">
            全部
          </button>
          <button v-tooltip="'只看「问 AI」记录'" :class="{ active: filter === 'ask' }" @click="filter = 'ask'">
            问 AI
          </button>
          <button v-tooltip="'只看「运行脚本」记录'" :class="{ active: filter === 'run' }" @click="filter = 'run'">
            运行脚本
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
          运行脚本或复制 prompt 后自动记录
        </div>
      </div>
      <div v-for="e in filtered" :key="e.id" class="trace-card" :class="[e.kind, { err: e.kind === 'run' && e.payload.ok === false }]">
        <div class="trace-head" @click="toggle(e.id)">
          <span class="trace-badge" :class="e.kind">{{ e.kind === 'ask' ? 'ASK' : 'RUN' }}</span>
          <span class="trace-summary">{{ e.summary }}</span>
          <span class="trace-time">{{ fmtTime(e.ts) }}</span>
          <button v-tooltip="'删除这条记录'" class="trace-del" @click.stop="removeTrace(e.id)">
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
              <pre class="trace-pre">{{ e.payload.question }}</pre>
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
              <pre class="trace-pre">{{ e.payload.prompt }}</pre>
            </div>
          </template>
          <template v-else>
            <div v-if="e.payload.script" class="trace-section">
              <div class="trace-label">
                <span>脚本</span><button class="trace-mini" @click="copyText(e.payload.script || '')">
                  复制
                </button>
              </div>
              <pre class="trace-pre">{{ e.payload.script }}</pre>
            </div>
            <div v-if="e.payload.changes && e.payload.changes.length" class="trace-section">
              <div class="trace-label">
                <span>变更（{{ e.payload.changes.length }}）</span>
              </div>
              <ul class="trace-changes">
                <li v-for="c in e.payload.changes" :key="c.path">
                  <span class="chg" :class="c.type">{{ c.type.charAt(0).toUpperCase() }}</span>{{ c.path }}
                </li>
              </ul>
            </div>
            <div v-if="e.payload.stdout" class="trace-section">
              <div class="trace-label">
                <span>stdout</span><button class="trace-mini" @click="copyText(e.payload.stdout || '')">
                  复制
                </button>
              </div>
              <pre class="trace-pre">{{ e.payload.stdout }}</pre>
            </div>
            <div v-if="e.payload.stderr" class="trace-section">
              <div class="trace-label">
                <span>stderr</span><button class="trace-mini" @click="copyText(e.payload.stderr || '')">
                  复制
                </button>
              </div>
              <pre class="trace-pre err">{{ e.payload.stderr }}</pre>
            </div>
          </template>
        </div>
      </div>
    </div>
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
  gap: 12px;
  padding: 10px 14px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
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
  border-radius: 10px;
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
  border-radius: 6px;
}
.trace-tabs button {
  padding: 3px 10px;
  border: 0;
  border-radius: 4px;
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
  border-radius: 6px;
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
}
.trace-list::-webkit-scrollbar {
  width: 8px;
}
.trace-list::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: 4px;
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
  border: 1px solid var(--border);
  border-radius: 8px;
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
  border-radius: 4px;
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
  border-radius: 4px;
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
  border-radius: 4px;
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
  border-radius: 6px;
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
  border-radius: 6px;
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
.chg {
  display: inline-block;
  width: 14px;
  text-align: center;
  font-weight: 700;
  margin-right: 4px;
}
.chg.added {
  color: var(--success);
}
.chg.modified {
  color: var(--warning);
}
.chg.deleted {
  color: var(--danger);
}
</style>
<!-- tooltip-audit -->
