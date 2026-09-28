<script setup lang="ts">
import { computed } from 'vue'
import type { Change, ChangeType } from '../../types'

defineOptions({ name: 'FileList' })

/** 组件接收的 props 定义 */
const props = defineProps<{
  changes: Change[]
  rolling: Record<string, boolean>
  busyAll: boolean
  activeFile?: string
}>()

/** 派发 */
const emit = defineEmits<{
  rollback: [file: string]
  rollbackAll: []
  save: []
  preview: [file: string] // ← 改为元组属性语法
}>()

/** 摘要 */
const summary = computed(() => {
  const s: Record<ChangeType, number> = { added: 0, modified: 0, deleted: 0 }
  for (const c of props.changes) s[c.type]++
  return s
})

/**
 * 取变更类型对应的展示元信息（徽标字母 / tooltip / CSS 类）
 * [WHY] 集中在此处映射避免模板里三处重复 switch；label 用于紧凑徽标，title 用于 tooltip
 * [CONSTRAINT] 键必须覆盖 ChangeType 全部取值，否则模板渲染会拿到 undefined
 * @param t 变更类型（added / modified / deleted）
 */
function metaOf(t: ChangeType) {
  return {
    added: { label: 'A', title: '新增', cls: 'added' },
    modified: { label: 'M', title: '修改', cls: 'modified' },
    deleted: { label: 'D', title: '删除', cls: 'deleted' },
  }[t]
}

/**
 * 把文件路径拆成目录前缀与文件名
 * [WHY] 列表展示时目录用浅色、文件名用主色，需要单独字段
 * [CONSTRAINT] 只按 POSIX 斜杠切分；无斜杠时 dir 返回空串（非 './'）
 * [CHANGE-IMPACT] 模板里两处 slot 依赖返回结构 {dir, name}
 * @param p 文件相对路径
 */
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
  border-radius: var(--radius-8);
  box-shadow: 0 1px 2px rgb(15 30 60 / 4%);
  overflow: hidden;
}

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
  border-radius: var(--radius-10);
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
  border-radius: var(--radius-10);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.s-pill .s-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
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
  border-radius: var(--radius-4);
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
  border-radius: var(--radius-4);
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

.file-list {
  max-height: 320px;
  overflow-y: auto;
}
.file-list::-webkit-scrollbar {
  width: 8px;
}
.file-list::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: var(--radius-4);
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

.letter {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-4);
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
  border-radius: var(--radius-4);
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
  opacity: 0.5;
  cursor: not-allowed;
}

.undo-icon {
  font-size: 14px;
  line-height: 1;
}

.spinner-mini {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

[class*='file']:hover:not(.is-active) {
  background: var(--surface-2, #f9fafb);
}

.ghost-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  border-radius: var(--radius-6);
  padding: 4px 10px;
  font-size: var(--font-12);
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 8%);
}
.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.save-btn,
.btn-primary {
  background: var(--primary);
  color: #fff;
  border: 0;
  box-shadow: none;
  border-radius: var(--radius-6);
}
.save-btn:hover:not(:disabled),
.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover);
  box-shadow: none;
}

.undo-btn {
  background: transparent;
  border: 0;
  color: var(--text-3);
}
.undo-btn:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%);
  color: var(--danger);
}

.save-btn,
.btn-primary {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
}
.save-btn:hover:not(:disabled),
.btn-primary:hover:not(:disabled) {
  background: var(--primary-bg);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
  box-shadow: none;
}
</style>
<!-- tooltip-audit -->
