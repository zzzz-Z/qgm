<script setup lang="ts">
defineOptions({ name: 'FileList' })
import { computed } from 'vue'
import type { Change, ChangeType } from '../types'

const props = defineProps<{
  changes: Change[]
  rolling: Record<string, boolean>
  busyAll: boolean
  activeFile?: string
}>()

const emit = defineEmits<{
  rollback: [file: string]
  rollbackAll: []
  save: []
  preview: [file: string] // ← 改为元组属性语法
}>()

const summary = computed(() => {
  const s: Record<ChangeType, number> = { added: 0, modified: 0, deleted: 0 }
  for (const c of props.changes) s[c.type]++
  return s
})

function metaOf(t: ChangeType) {
  return {
    added: { label: 'A', title: '新增', cls: 'added' },
    modified: { label: 'M', title: '修改', cls: 'modified' },
    deleted: { label: 'D', title: '删除', cls: 'deleted' },
  }[t]
}

function splitPath(p: string) {
  const idx = p.lastIndexOf('/')
  if (idx < 0) return { dir: '', name: p }
  return { dir: p.slice(0, idx + 1), name: p.slice(idx + 1) }
}
</script>

<template>
  <section class="changes">
    <header class="changes-bar">
      <div class="summary">
        <span class="summary-title">变更</span>
        <span class="summary-count">{{ changes.length }}</span>
        <span class="summary-dots">
          <span v-if="summary.modified" v-tooltip="`修改 ${summary.modified}`" class="s-pill modified">
            <span class="s-dot" />{{ summary.modified }}
          </span>
          <span v-if="summary.added" v-tooltip="`新增 ${summary.added}`" class="s-pill added">
            <span class="s-dot" />{{ summary.added }}
          </span>
          <span v-if="summary.deleted" v-tooltip="`删除 ${summary.deleted}`" class="s-pill deleted">
            <span class="s-dot" />{{ summary.deleted }}
          </span>
        </span>
      </div>
      <div class="bar-actions">
        <button v-tooltip="busyAll ? '处理中…' : '把本次运行改动的文件全部还原到改动前'" class="ghost-btn" :disabled="busyAll" @click="emit('rollbackAll')">
          {{ busyAll ? '处理中…' : '撤回全部' }}
        </button>
        <button
          v-tooltip="busyAll ? '处理中…' : '确认所有改动并删除本次快照（之后无法撤回）'"
          class="save-btn"
          :disabled="busyAll"
          @click="emit('save')"
        >
          {{ busyAll ? '处理中…' : '确认改动' }}
        </button>
      </div>
    </header>

    <div class="file-list">
      <div v-for="c in changes" :key="c.path" class="file-row" :class="[c.type, { 'is-active': c.path === activeFile }]" style="cursor:pointer" @click="emit('preview', c.path)">
        <span v-tooltip="metaOf(c.type).title" class="letter" :class="c.type">
          {{ metaOf(c.type).label }}
        </span>
        <span class="path">
          <span class="dir">{{ splitPath(c.path).dir }}</span><span class="name">{{ splitPath(c.path).name }}</span>
        </span>
        <button
          v-tooltip="`撤回 ${c.path}`"
          class="undo-btn"
          :disabled="rolling[c.path]"
          @click.stop="emit('rollback', c.path)"
        >
          <span v-if="rolling[c.path]" class="spinner-mini" />
          <span v-else class="undo-icon">↺</span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.changes {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 1px 2px rgb(15 30 60 / 4%);
  overflow: hidden;
}

/* ---------- 头部 ---------- */
.changes-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 40px;
  padding: 0 12px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.summary {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.summary-title {
  font-weight: 600;
  color: var(--text);
}
.summary-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 7px;
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: 10px;
  font-size: 11px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.summary-dots {
  display: flex;
  gap: 6px;
}
.s-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.s-pill .s-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}
.s-pill.modified {
  color: var(--primary);
  background: var(--primary-bg);
}
.s-pill.added {
  color: var(--success);
  background: var(--success-bg);
}
.s-pill.deleted {
  color: var(--danger);
  background: var(--danger-bg);
}

.bar-actions {
  display: flex;
  gap: 6px;
}

.ghost-btn {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: 0.12s;
}
.ghost-btn:hover:not(:disabled) {
  background: rgb(239 68 68 / 8%);
  color: var(--danger);
  border-color: rgb(239 68 68 / 20%);
}
.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.save-btn {
  padding: 4px 12px;
  background: var(--primary);
  color: #fff;
  border: 0;
  border-radius: 5px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: 0.12s;
  box-shadow: 0 1px 2px rgb(37 99 235 / 25%);
}
.save-btn:hover:not(:disabled) {
  background: var(--primary-hover);
}
.save-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
  box-shadow: none;
}

/* ---------- 文件列表 ---------- */
.file-list {
  max-height: 320px;
  overflow-y: auto;
}
.file-list::-webkit-scrollbar {
  width: 8px;
}
.file-list::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: 4px;
}
.file-list::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}

.file-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 12px;
  font: 12px/1.5 var(--mono);
  border-bottom: 1px solid var(--border);
  transition: background 0.1s;
}
.file-row:last-child {
  border-bottom: 0;
}
.file-row:hover {
  background: var(--surface-2);
}
.file-row:hover .undo-btn {
  opacity: 1;
}

/* 左侧单字母标签（A/M/D） */
.letter {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  font: 11px/1 var(--mono);
  font-weight: 700;
}
.letter.modified {
  color: var(--primary);
  background: var(--primary-bg);
}
.letter.added {
  color: var(--success);
  background: var(--success-bg);
}
.letter.deleted {
  color: var(--danger);
  background: var(--danger-bg);
}

.path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.path .dir {
  color: var(--text-3);
}
.path .name {
  color: var(--text);
  font-weight: 500;
}

.undo-btn {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.12s,
    background 0.12s,
    color 0.12s;
}
.undo-btn:hover:not(:disabled) {
  color: var(--danger);
  background: var(--danger-bg);
}
.undo-btn:disabled {
  opacity: 0.5 !important;
  cursor: not-allowed;
}

.undo-icon {
  font-size: 14px;
  line-height: 1;
}

.spinner-mini {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.file-item.is-active,
[class*='file'].is-active {
  background: rgb(37 99 235 / 8%);
  border-color: var(--primary, #2563eb);
}
[class*='file']:hover:not(.is-active) {
  background: var(--surface-2, #f9fafb);
}

/* ═══════════════════════════════════════════════════════════
   [button-theme] 按钮配色重做：暖橙强调 + 灰阶次按钮
   参考 Claude Code / Codex 克制配色
   ═══════════════════════════════════════════════════════════ */

/* ——— 次按钮：透明底 + 细边框，hover 时淡淡提亮 ——— */
.ghost-btn {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  padding: 4px 10px !important;
  font-size: var(--font-12) !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 8%) !important;
}
.ghost-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }

/* ——— 终端内按钮 ——— */
.term-btn {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.term-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.term-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }
.term-btn.copy, .term-btn.ask-panel { color: var(--text-2) !important; border-color: rgb(255 255 255 / 8%) !important; }
.term-btn.copy:hover:not(:disabled), .term-btn.ask-panel:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important; color: var(--text) !important; border-color: rgb(255 255 255 / 14%) !important;
}

/* ——— 芯片 / 下拉 / tab ——— */
.tpl-chip {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
}
.tpl-chip:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.draft-select {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
}
.draft-select:hover { border-color: rgb(255 255 255 / 14%) !important; }

/* ——— primary 系列（运行/主操作）：暖橙实底 ——— */
.primary-btn.run {
  background: var(--primary) !important;
  color: #fff !important;
  box-shadow: none !important;
  border: 0 !important;
}
.primary-btn.run:hover:not(:disabled) { background: var(--primary-hover) !important; box-shadow: none !important; }

/* 运行按钮（takeover 态）：暖橙描边，非实心，更克制 */
.primary-btn.takeover {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(217 119 87 / 12%) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
}

/* 停止 / 暂停：柔和红描边 */
.primary-btn.stop {
  background: transparent !important;
  color: var(--danger) !important;
  border: 1px solid var(--danger) !important;
  box-shadow: none !important;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  color: #fff !important;
  border-color: var(--danger) !important;
}

/* ——— loop-btn 系列 ——— */
.loop-btn {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  box-shadow: none !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.loop-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.loop-btn:active:not(:disabled) { box-shadow: none !important; }
.loop-btn:focus-visible { outline: 0 !important; box-shadow: 0 0 0 2px rgb(217 119 87 / 30%) !important; }
.loop-btn:disabled { opacity: 0.4 !important; background: transparent !important; color: var(--text-3) !important; }

.loop-btn.primary {
  background: var(--primary) !important;
  border-color: var(--primary) !important;
  color: #fff !important;
  box-shadow: none !important;
}
.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  color: #fff !important;
  box-shadow: none !important;
}
.loop-btn.kill, .loop-btn.rollback {
  background: transparent !important;
  border-color: rgb(224 108 117 / 55%) !important;
  color: var(--danger) !important;
  box-shadow: none !important;
}
.loop-btn.kill:hover:not(:disabled), .loop-btn.rollback:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  border-color: var(--danger) !important;
  color: #fff !important;
  box-shadow: none !important;
}

/* ——— 决策按钮 ——— */
.decision-btn {
  background: rgb(217 119 87 / 12%) !important;
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  font-weight: 600 !important;
}
.decision-btn:hover:not(:disabled) {
  background: var(--primary) !important;
  color: #fff !important;
  border-color: var(--primary) !important;
}

/* ——— 焦点环统一暖橙 ——— */
.primary-btn:focus-visible, .term-btn:focus-visible, .ghost-btn:focus-visible, .tpl-chip:focus-visible, .draft-select:focus-visible {
  outline: 0 !important;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 35%) !important;
}

/* ——— 图标按钮（App 头部）——— */
.theme-toggle, .trace-toggle, .settings-toggle, .ask-toggle, .timeline-toggle {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--text-2) !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.theme-toggle:hover, .trace-toggle:hover, .settings-toggle:hover, .ask-toggle:hover, .timeline-toggle:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 10%) !important;
}

/* ——— 主色大按钮（FileList.save-btn / GeneratePanel.btn-primary）——— */
.save-btn, .btn-primary {
  background: var(--primary) !important;
  color: #fff !important;
  border: 0 !important;
  box-shadow: none !important;
  border-radius: 6px !important;
}
.save-btn:hover:not(:disabled), .btn-primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  box-shadow: none !important;
}

/* ——— FileList 撤回按钮 ——— */
.undo-btn {
  background: transparent !important;
  border: 0 !important;
  color: var(--text-3) !important;
}
.undo-btn:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  color: var(--danger) !important;
}

/* ——— FileTree 刷新 ——— */
.refresh { background: transparent !important; border: 0 !important; color: var(--text-3) !important; }
.refresh:hover:not(:disabled) { background: rgb(255 255 255 / 6%) !important; color: var(--text) !important; }


/* [button-theme-v2] 主按钮去实底 */
.save-btn, .btn-primary {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.save-btn:hover:not(:disabled), .btn-primary:hover:not(:disabled) {
  background: var(--primary-bg) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  box-shadow: none !important;
}

</style>
<!-- tooltip-audit -->
