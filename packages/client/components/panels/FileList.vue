<script setup lang="ts">
import type { ChangeEntry, ChangeType } from '../../types'

/** 组件接收的 props 定义 */
const props = defineProps<{
  changes: ChangeEntry[]
  rolling: Record<string, boolean>
  busyAll: boolean
  activeFile?: string
  /** [cumulative-baseline-v1] 当前视图：影响撤回文案与「归属轮不可用」的提示口径 */
  view: 'round' | 'cumulative'
}>()
/** 派发 */
const emit = defineEmits<{
  rollback: [file: string]
  rollbackAll: []
  save: []
  preview: [file: string] // ← 改为元组属性语法
}>()

defineOptions({ name: 'FileList' })

/** 摘要 */
const summary = computed(() => {
  const s: Record<ChangeType, number> = { added: 0, modified: 0, deleted: 0 }
  for (const c of props.changes) s[c.type]++
  return s
})
/**
 * [filelist-head-v1] 类型明细的展示顺序与徽标字母：与列表行的 letter 完全同源
 * [WHY] 旧实现的摘要是「色点 + 数字」，颜色是唯一线索 —— 色弱用户与首次使用者读不出
 *   「•2」是修改还是新增；字母与行内徽标同形后，摘要与列表自解释且互相对照。
 * [CONSTRAINT] 字母必须与 metaOf 的 label 一致，否则摘要与行内会互相矛盾
 */
const summaryItems = computed(() => [
  { key: 'modified' as ChangeType, letter: 'M', label: '修改', n: summary.value.modified },
  { key: 'added' as ChangeType, letter: 'A', label: '新增', n: summary.value.added },
  { key: 'deleted' as ChangeType, letter: 'D', label: '删除', n: summary.value.deleted },
].filter(i => i.n > 0))
/**
 * [cumulative-baseline-v1] 撤回全部按钮的提示：累积视图下逐条按归属轮还原，措辞必须与实现一致
 * [WHY] 否则用户以为「撤的是最后一轮」，实际撤的是整个会话累计——文案与行为不符是误导
 */
const rollbackAllTitle = computed(() => {
  if (props.busyAll) return '处理中…'
  return props.view === 'cumulative'
    ? '把所有列出的文件按各自归属轮还原到基准状态'
    : '把本次运行改动的文件全部还原到改动前'
})
// [filelist-rows-v1] 报告 §5.1.4：模板里每行调用 metaOf 2 次 + splitPath 2 次；
// 改为一次预生成，重渲染时零重复计算。依赖 props.changes，自动随变更集刷新。
const rows = computed(() => props.changes.map((c) => {
  const meta = metaOf(c.type)
  const sp = splitPath(c.path)
  // [cumulative-baseline-v1] rollbackable === false：归属轮的历史内容已被 gcSnapshots 回收，
  //   服务端 /rollback 会 500；前端直接禁用并为「为什么点不了」给出原因
  const locked = c.rollbackable === false
  const undoTitle = locked
    ? '该文件所属运行的历史内容已被回收，无法撤回'
    : props.view === 'cumulative'
      ? `撤销 ${c.path} 自基准以来的全部改动`
      : `撤回 ${c.path}`
  return { path: c.path, type: c.type, label: meta.label, title: meta.title, dir: sp.dir, name: sp.name, locked, undoTitle }
}))

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
    <!-- [filelist-head-v1] 头部改为**上下两行**：上行信息（标题 + 总数 + 类型明细），下行动作（两个等宽按钮）。
         [WHY] 旧实现是「单行 justify-between」，而侧栏默认只有 320px、减去内边距≈288px：
         标题 + 4 个徽标 + 两个文字按钮的**最小内容宽**约 300px ⇒ flex 把每个字都挤成一行，
         实测标题被劈成 3 行、按钮各 84px 高并溢出 40px 的固定高度头部，压住第一条文件行。
         两行布局把「最窄可用宽度」降到动作行的 2×约 70px，任何侧栏宽度下都不再折字。 -->
    <header class="changes-bar">
      <div class="summary">
        <span class="summary-title">{{ view === 'cumulative' ? '累积变更' : '本轮变更' }}</span>
        <span v-tooltip="`共 ${changes.length} 个文件`" class="summary-count">{{ changes.length }}</span>
        <span class="summary-dots">
          <span v-for="it in summaryItems" :key="it.key" v-tooltip="`${it.label} ${it.n}`" class="s-pill" :class="it.key">
            <b class="s-key">{{ it.letter }}</b>{{ it.n }}
          </span>
        </span>
      </div>
      <div class="bar-actions">
        <button v-tooltip="rollbackAllTitle" class="act-btn ghost-btn" :disabled="busyAll" @click="emit('rollbackAll')">
          <svg class="act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
          </svg>
          <span>{{ busyAll ? '处理中…' : '撤回全部' }}</span>
        </button>
        <button
          v-tooltip="busyAll ? '处理中…' : '确认所有改动并删除本次快照（之后无法撤回）'"
          class="act-btn save-btn"
          :disabled="busyAll"
          @click="emit('save')"
        >
          <svg class="act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span>{{ busyAll ? '处理中…' : '确认改动' }}</span>
        </button>
      </div>
    </header>

    <div class="file-list">
      <div v-for="c in rows" :key="c.path" class="file-row" :class="[c.type, { 'is-active': c.path === activeFile }]" style="cursor:pointer" role="button" :aria-label="`预览 ${c.path}`" tabindex="0" @click="emit('preview', c.path)" @keydown.enter.prevent="emit('preview', c.path)">
        <span v-tooltip="c.title" class="letter" :class="c.type">
          {{ c.label }}
        </span>
        <span class="path">
          <span class="dir">{{ c.dir }}</span><span class="name">{{ c.name }}</span>
        </span>
        <button
          v-tooltip="c.undoTitle"
          :aria-label="c.undoTitle"
          class="undo-btn"
          :disabled="rolling[c.path] || c.locked"
          @click.stop="emit('rollback', c.path)"
        >
          <span v-if="rolling[c.path]" class="spinner-mini" />
          <svg v-else class="undo-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
          </svg>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped lang="scss">
.changes {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 1px 2px rgb(15 30 60 / 4%);
  overflow: hidden;
}

/* [filelist-head-v1] 去掉写死的 40px 高度：两行头部是内容撑开，固定高会让动作行溢出压住列表 */
.changes-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}
.summary {
  @apply flex items-center gap-1.5;
  min-width: 0;
  overflow: hidden;
}
.summary-title {
  font-size: var(--font-12);
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}
.summary-count {
  @apply inline-flex items-center justify-center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: var(--radius-4);
  font-size: var(--font-11);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.summary-dots {
  @apply flex items-center gap-1;
  overflow: hidden;
}
.s-pill {
  @apply inline-flex items-center;
  gap: 3px;
  height: 18px;
  padding: 0 6px 0 5px;
  border-radius: var(--radius-4);
  font-size: var(--font-11);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.s-pill .s-key {
  font-family: var(--mono);
  font-size: var(--font-10);
  font-weight: 700;
  opacity: 0.9;
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

/* 动作行：两个按钮等宽平分，文字永不断行 */
.bar-actions {
  @apply flex gap-1.5;
}
.act-btn {
  flex: 1 1 0;
  @apply inline-flex items-center justify-center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border-radius: var(--radius-6);
  font-size: var(--font-12);
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 0.12s,
    color 0.12s,
    border-color 0.12s;
}
.act-btn .act-icon {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
}
.act-btn:focus-visible {
  outline: 0;
  box-shadow: var(--shadow-focus);
}
.act-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* [filelist-btnprimary-cleanup-v1] 删除模板零引用的 .btn-primary 选择器 */
/* 次要动作（撤回全部）：描边幽灵按钮，hover 才染危险色 —— 破坏性动作不该常驻高饱和 */
.bar-actions .ghost-btn {
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border-2);
}
.bar-actions .ghost-btn:hover:not(:disabled) {
  background: var(--danger-bg);
  color: var(--danger);
  border-color: var(--danger);
}
/* 主动作（确认改动）：实心主色，与「撤回全部」形成主次对比（旧实现两者都是描边，无主次） */
.bar-actions .save-btn {
  background: var(--primary);
  color: #fff;
  border: 1px solid var(--primary);
}
.bar-actions .save-btn:hover:not(:disabled) {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
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
  @apply flex items-center gap-2.5;
  padding: 7px 10px;
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
/* [filelist-active-v1] 预览中的文件此前**没有任何视觉标记**（is-active 只在模板里挂类、无样式），
   点击行之后用户看不出「现在预览的是哪一条」。左缘主色条 + 淡底，与行内 hover 区分开。 */
.file-row.is-active {
  background: var(--primary-bg);
  box-shadow: inset 2px 0 0 var(--primary);
}
.file-row:hover .undo-btn {
  opacity: 1;
}

.letter {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  @apply flex items-center justify-center;
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

/* [filelist-undo-affordance-v1] 撤回按钮改为**常驻低透明**：旧实现 opacity:0 只在 hover 显现，
   触屏与键盘用户根本发现不了有这个操作（hover 才会出现 = 等于没有）。 */
.undo-btn {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  @apply flex items-center justify-center;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-4);
  cursor: pointer;
  opacity: 0.55;
  transition:
    opacity 0.12s,
    background 0.12s,
    color 0.12s;
}
.undo-btn:hover:not(:disabled) {
  background: var(--danger-bg);
  color: var(--danger);
}
.undo-btn:disabled {
  opacity: 0.28;
  cursor: not-allowed;
}

.undo-icon {
  width: 12px;
  height: 12px;
}

.spinner-mini {
  width: 10px;
  height: 10px;
  border-radius: var(--radius-full);
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}

.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
</style>
<!-- tooltip-audit -->
