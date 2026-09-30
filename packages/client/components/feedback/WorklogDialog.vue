<script setup lang="ts">
// @desc 工作日志弹窗：从 /__ai/git/worklog 拉取 Markdown 日志并展示
// @why  用户需求"用 git diff 生成工作日志"；后端 gitWorklog 已就位，本组件仅做 UI 呈现与导出
// @change-impact 依赖 /__ai/git/worklog 端点契约（WorklogResult）；渲染走 renderMarkdown

import { computed, ref, watch } from 'vue'
import { useClipboard } from '@vueuse/core'
import { renderMarkdown } from '../../composables/useMarkdown'

interface WorklogFileEntry { path: string, status: string, added: number, removed: number }
interface WorklogResult { ok: boolean, reason?: string, since: string, until: string, generatedAt: number, files: WorklogFileEntry[], history: string[], stat: string, markdown: string }

const props = defineProps<{ visible: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { copy } = useClipboard()
const loading = ref(false)
const result = ref<WorklogResult | null>(null)
const error = ref('')
const includeHistory = ref(true)
// [worklog-v2] ref 区间：since 默认 'HEAD'（未提交变更），until 默认空（工作区）
// [CONSTRAINT] 后端白名单过滤 [A-Za-z0-9._~^/\-]；此处不再重复校验，交由 gitWorklog 处理非法 ref
const sinceRef = ref('')
const untilRef = ref('')

const markdownHtml = computed(() => result.value ? renderMarkdown(result.value.markdown) : '')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await fetch('/__ai/git/worklog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        includeHistory: includeHistory.value,
        since: sinceRef.value.trim() || undefined,
        until: untilRef.value.trim() || undefined,
      }),
    })
    const j = await r.json().catch(() => ({})) as WorklogResult
    if (!r.ok || !j.ok) { error.value = j.reason || (`HTTP ${r.status}`); result.value = null; return }
    result.value = j
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    result.value = null
  } finally {
    loading.value = false
  }
}

watch(() => props.visible, (v) => { if (v) void load() })

async function copyMarkdown() {
  if (!result.value) return
  try { await copy(result.value.markdown) } catch { /* ignore */ }
}

function downloadMarkdown() {
  if (!result.value) return
  const blob = new Blob([result.value.markdown], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `worklog-${new Date().toISOString().slice(0, 10)}.md`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function onKey(e: KeyboardEvent) { if (e.key === 'Escape') emit('close') }
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="wl-mask" tabindex="-1" @click.self="emit('close')" @keydown="onKey">
      <div class="wl-card" role="dialog" aria-modal="true">
        <div class="wl-head">
          <span class="wl-badge">WORKLOG</span>
          <span class="wl-title">工作日志 · git diff</span>
          <label class="wl-toggle">
            <input v-model="includeHistory" type="checkbox" :disabled="loading" @change="load">
            <span>含最近提交</span>
          </label>
          <button class="wl-btn wl-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
        </div>
        <div class="wl-refs">
          <label class="wl-ref">
            <span class="wl-ref-label">起点</span>
            <input
              v-model="sinceRef"
              class="wl-ref-input"
              type="text"
              placeholder="HEAD（默认未提交）"
              spellcheck="false"
              :disabled="loading"
              @keydown.enter.prevent="load"
            >
          </label>
          <label class="wl-ref">
            <span class="wl-ref-label">终点</span>
            <input
              v-model="untilRef"
              class="wl-ref-input"
              type="text"
              placeholder="留空=工作区"
              spellcheck="false"
              :disabled="loading"
              @keydown.enter.prevent="load"
            >
          </label>
        </div>
        <div class="wl-body">
          <div v-if="loading" class="wl-state">
            加载中…
          </div>
          <div v-else-if="error" class="wl-state wl-error">
            {{ error }}
          </div>
          <div v-else-if="result && result.files.length === 0" class="wl-state">
            （无变更）
          </div>
          <div v-else class="wl-md" v-html="markdownHtml" />
        </div>
        <div class="wl-actions">
          <button class="wl-btn" :disabled="loading" @click="load">
            刷新
          </button>
          <button class="wl-btn" :disabled="!result || loading" @click="copyMarkdown">
            复制
          </button>
          <button class="wl-btn wl-primary" :disabled="!result || loading" @click="downloadMarkdown">
            下载 .md
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.wl-mask {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(15 30 60 / 32%);
}
.wl-card {
  display: flex;
  flex-direction: column;
  min-width: 480px;
  max-width: 720px;
  max-height: 80vh;
  background: var(--surface, #fff);
  border-radius: 12px;
  box-shadow: 0 20px 60px rgb(15 30 60 / 24%);
  overflow: hidden;
}
.wl-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px 10px;
  border-bottom: 1px solid var(--border, #e5e9f0);
}
.wl-badge {
  padding: 2px 6px;
  font:
    700 10px/1 ui-monospace,
    monospace;
  color: #fff;
  background: #2563eb;
  border-radius: 4px;
  letter-spacing: 0.5px;
}
.wl-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--text, #1f2d3d);
}
.wl-toggle {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-dim, #6b7280);
  cursor: pointer;
}
.wl-close {
  width: 24px;
  height: 24px;
  padding: 0;
  font-size: 18px;
  line-height: 1;
}
.wl-refs {
  display: flex;
  gap: 10px;
  padding: 0 20px 12px;
  border-bottom: 1px solid var(--border, #e5e9f0);
}
.wl-ref {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 6px;
}
.wl-ref-label {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-dim, #6b7280);
}
.wl-ref-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font:
    12px/1.4 ui-monospace,
    monospace;
  color: var(--text, #1f2d3d);
  background: var(--surface-2, #f3f5f9);
  border: 1px solid var(--border, #e5e9f0);
  border-radius: 6px;
  outline: none;
}
.wl-ref-input:focus {
  border-color: #2563eb;
}
.wl-body {
  flex: 1;
  min-height: 0;
  padding: 14px 20px;
  overflow-y: auto;
}
.wl-state {
  padding: 24px 0;
  font-size: 13px;
  color: var(--text-dim, #6b7280);
  text-align: center;
}
.wl-error {
  color: #dc2626;
}
.wl-md :deep(h1) {
  margin: 0 0 12px;
  font-size: 16px;
  font-weight: 700;
}
.wl-md :deep(h2) {
  margin: 12px 0 6px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text, #1f2d3d);
}
.wl-md :deep(p) {
  margin: 4px 0 8px;
}
.wl-md :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font:
    12px/1.5 ui-monospace,
    monospace;
}
.wl-md :deep(th),
.wl-md :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--border, #e5e9f0);
  text-align: left;
}
.wl-md :deep(th) {
  background: var(--surface-2, #f3f5f9);
}
.wl-md :deep(.md-pre) {
  margin: 8px 0;
  padding: 8px 10px;
  background: var(--surface-2, #f3f5f9);
  border: 1px solid var(--border, #e5e9f0);
  border-radius: 6px;
  font:
    12px/1.5 ui-monospace,
    monospace;
  white-space: pre;
  overflow-x: auto;
}
.wl-md :deep(.md-inline) {
  padding: 1px 5px;
  background: var(--surface-2, #f3f5f9);
  border-radius: 3px;
  font:
    12px/1.4 ui-monospace,
    monospace;
}
.wl-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--border, #e5e9f0);
}
.wl-btn {
  padding: 7px 14px;
  background: var(--surface, #fff);
  border: 1px solid var(--border-2, #d0d7de);
  border-radius: 8px;
  color: var(--text, #1f2d3d);
  font-size: 13px;
  cursor: pointer;
}
.wl-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.wl-primary {
  color: #fff;
  background: #2563eb;
  border-color: transparent;
}
</style>
