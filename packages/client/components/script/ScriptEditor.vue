<template>
  <section class="editor card" :class="{ 'is-running': isRunning, 'is-dragging': isDragging }">
    <slot name="tpl-bar" />
    <slot name="attach-bar" />
    <div
      class="editor-body"
      @paste.capture="(e) => emit('paste', e)"
      @dragenter="onDragEnter"
      @dragover.prevent="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop"
    >
      <!-- @FILE_PICKER_V1 -->
      <div v-if="pickerOpen" ref="pickerRef" class="file-picker" :style="pickerStyle">
        <input
          ref="pickerInputRef" v-model="pickerQuery" class="fp-input" placeholder="搜索文件，Enter 选择，Esc 取消"
          @keydown.down.prevent="pickerMove(1)" @keydown.up.prevent="pickerMove(-1)"
          @keydown.enter.prevent="pickerConfirm" @keydown.esc.prevent="pickerClose"
        >
        <div class="fp-list">
          <div
            v-for="(f, i) in pickerFiltered" :key="f" class="fp-item" :class="{ active: i === pickerIndex }"
            @mousedown.prevent="pickerPick(f)"
          >
            {{ f }}
          </div>
          <div v-if="!pickerFiltered.length" class="fp-empty">
            无匹配文件
          </div>
        </div>
      </div>
      <div ref="cmHost" class="cm-host" tabindex="0" />
    </div>
    <slot name="foot" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { FileNode } from '../../types'
import type { Decoration, DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/** 组件接收的 props 定义 */
const props = defineProps<{
  modelValue: string
  isRunning: boolean
  isLoopActive: boolean
  onRun?: () => boolean | void
  onHistoryPrev?: () => void
  onHistoryNext?: () => void
}>()

/** 派发 */
const emit = defineEmits<{
  'update:modelValue': [value: string]
  'paste': [e: ClipboardEvent]
  'drop': [e: DragEvent]
}>()

/* [drag-drop-ux-v1] 文件拖入的视觉反馈 */
// WHY: 原 editor-body 只挂 dragover.prevent + drop；无 dragenter 状态，CSS .is-dragging 系死代码
// CONSTRAINT: 子元素进出会连发 dragenter/dragleave，用 dragDepth 计数抵消，归零才复位
/** 是否处于「文件悬停输入框」态 */
const isDragging = ref(false)
/** dragenter 与 dragleave 的配对深度计数 */
let dragDepth = 0

/** 判定拖入是否携带文件（排除编辑器内文本选择产生的拖拽） */
function hasFiles(e: DragEvent): boolean {
  const dt = e.dataTransfer
  if (!dt) return false
  const types = Array.from(dt.types || [])
  return types.includes('Files')
}

/** dragenter：仅文件类型才激活遮罩；多次嵌套进出自增 */
function onDragEnter(e: DragEvent) {
  if (!hasFiles(e)) return
  dragDepth++
  isDragging.value = true
}

/** dragover：只改光标为 copy，不切状态（enter/leave 已负责状态） */
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
}

/** dragleave：计数递减，归零后关闭遮罩（避免子元素间穿梭时闪烁） */
function onDragLeave() {
  dragDepth--
  if (dragDepth <= 0) {
    dragDepth = 0
    isDragging.value = false
  }
}

/** drop：先复位，再 stopPropagation 防冒泡到 ScriptPanel.mainRef 的双触发（旧行为会同时插文本） */
function onDrop(e: DragEvent) {
  e.preventDefault()
  e.stopPropagation()
  dragDepth = 0
  isDragging.value = false
  emit('drop', e)
}

// [p1-2-client-v3] CM 动态 import 聚合类型：从各包具名导出反推，杜绝 any
interface CMModule {
  EditorView: typeof import('@codemirror/view').EditorView
  keymap: typeof import('@codemirror/view').keymap
  placeholder: typeof import('@codemirror/view').placeholder
  Decoration: typeof import('@codemirror/view').Decoration
  ViewPlugin: typeof import('@codemirror/view').ViewPlugin
  EditorState: typeof import('@codemirror/state').EditorState
  Prec: typeof import('@codemirror/state').Prec
  Compartment: typeof import('@codemirror/state').Compartment
  RangeSetBuilder: typeof import('@codemirror/state').RangeSetBuilder
  basicSetup: typeof import('codemirror').basicSetup
  cmJavascript: typeof import('@codemirror/lang-javascript').javascript
  oneDark: typeof import('@codemirror/theme-one-dark').oneDark
}
let CM: CMModule | null = null

/**
 * 确保 CM
 */
async function ensureCM(): Promise<CMModule> {
  if (CM) return CM
  const [v, s, j, t, c] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/theme-one-dark'),
    import('codemirror'),
  ])
  CM = {
    EditorView: v.EditorView,
    keymap: v.keymap,
    placeholder: v.placeholder,
    Decoration: v.Decoration,
    ViewPlugin: v.ViewPlugin,
    EditorState: s.EditorState,
    Prec: s.Prec,
    Compartment: s.Compartment,
    RangeSetBuilder: s.RangeSetBuilder,
    basicSetup: c.basicSetup,
    cmJavascript: j.javascript,
    oneDark: t.oneDark,
  }
  return CM
}

/** CodeMirror 编辑器容器 DOM */
const cmHost = ref<HTMLDivElement | null>(null)
let cmView: import('@codemirror/view').EditorView | null = null
let editableComp: import('@codemirror/state').Compartment | null = null

/* @FILE_PICKER_V1 */
/** 打开 */
const pickerOpen = ref(false)
/** 文件选择器的检索关键词 */
const pickerQuery = ref('')
/** 索引 */
const pickerIndex = ref(0)
/** 文件选择器弹出位置 */
const pickerPos = ref(0)
/** 文件选择器的锚点元素 */
const pickerAnchor = ref(0)
/** 文件选择器的 X 坐标 */
const pickerX = ref(0)
/** 文件选择器的 Y 坐标 */
const pickerY = ref(0)
/** 引用 */
const pickerRef = ref<HTMLDivElement | null>(null)
/** 输入引用 */
const pickerInputRef = ref<HTMLInputElement | null>(null)
/** 文件 */
const pickerFiles = ref<string[]>([])
/** 文件选择器的内联样式 */
const pickerStyle = computed(() => ({ left: `${pickerX.value}px`, top: `${pickerY.value}px` }))

/**
 * 执行 picker Load Files
 */
async function pickerLoadFiles() {
  if (pickerFiles.value.length) return
  try {
    const res = await fetch('/__ai/files?depth=6')
    const data = await res.json()
    const flat: string[] = []
    const walk = (nodes: FileNode[]) => {
      for (const n of nodes || []) {
        if (n.type === 'file') flat.push(n.path)
        else if (n.children) walk(n.children)
      }
    }
    walk(data.tree || [])
    pickerFiles.value = flat
  } catch { pickerFiles.value = [] }
}

/** 文件选择器过滤后的结果 */
const pickerFiltered = computed(() => {
  const q = pickerQuery.value.toLowerCase()
  const all = pickerFiles.value
  if (!q) return all.slice(0, 200)
  return all.filter(p => p.toLowerCase().includes(q)).slice(0, 200)
})

/**
 * 执行 picker Open At
 * @param atPos - at Pos
 */
function pickerOpenAt(atPos: number) {
  pickerOpen.value = true
  pickerQuery.value = ''
  pickerIndex.value = 0
  pickerPos.value = atPos
  pickerAnchor.value = atPos + 1
  if (cmView) {
    const coords = cmView.coordsAtPos(atPos)
    if (coords) {
      pickerX.value = coords.left
      pickerY.value = coords.bottom + 4
    }
  }
  void pickerLoadFiles()
  nextTick(() => pickerInputRef.value?.focus())
}

/**
 * 执行 picker Close
 */
function pickerClose() {
  pickerOpen.value = false
  pickerQuery.value = ''
  pickerIndex.value = 0
}

/**
 * 在 @ 文件选择器中循环移动选中项
 * [CONSTRAINT] 用模运算实现环回（末项继续下移回到首项）；空列表直接返回
 * [WHY] +d+n 避免负数取模在不同语言下语义不一致
 * @param d 位移量（+1 下移 / -1 上移）
 */
function pickerMove(d: number) {
  const n = pickerFiltered.value.length
  if (!n) return
  pickerIndex.value = (pickerIndex.value + d + n) % n
}

/**
 * 确认当前选中的文件并插入路径（Enter 触发）
 * [CONSTRAINT] 列表为空时静默 no-op；具体插入逻辑在 pickerPick 中
 */
function pickerConfirm() {
  const f = pickerFiltered.value[pickerIndex.value]
  if (f) pickerPick(f)
}

/**
 * 执行 picker Pick
 * @param filePath - file Path
 */
function pickerPick(filePath: string) {
  if (!cmView) return
  pickerOpen.value = false
  const insertText = `@${filePath} `
  const from = pickerPos.value
  const to = cmView.state.selection.main.head
  cmView.dispatch({ changes: { from, to, insert: insertText }, selection: { anchor: from + insertText.length } })
  pickerQuery.value = ''
  pickerIndex.value = 0
  cmView.focus()
}

/**
 * 编辑器内容/光标变更回调（驱动 @ 文件选择器）
 * [WHY] 只在 docChanged 时处理：单纯光标移动不触发选择器逻辑，减少无谓计算
 * [CONSTRAINT] @ 需位于光标前一个字符（pos-1）才算触发；空格/换行后跟 @ 时不被识别
 * [CHANGE-IMPACT] 会写 pickerOpen / pickerQuery / pickerPos，模板中多个 UI 依赖这些 ref
 * @param u CodeMirror ViewUpdate；含 docChanged / state.selection 等字段
 */
function onEditorUpdate(u: ViewUpdate) {
  if (!u.docChanged) return
  const pos = u.state.selection.main.head
  if (pos < 1) return
  const ch = u.state.sliceDoc(pos - 1, pos)
  if (ch === '@') {
    pickerOpenAt(pos - 1)
    return
  }
  if (pickerOpen.value) {
    if (pos <= pickerPos.value) { pickerClose(); return }
    const q = u.state.sliceDoc(pickerAnchor.value, pos)
    if (/^[\w./-]*$/.test(q)) pickerQuery.value = q
    else pickerClose()
  }
}

let fileTagPlugin: Extension | null = null
/**
 * 创建 Editor
 */
async function createEditor() {
  if (!cmHost.value || cmView) return
  const m = await ensureCM()
  if (!editableComp) editableComp = new m.Compartment()
  if (!fileTagPlugin) {
    fileTagPlugin = m.ViewPlugin.fromClass(class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = this.build(view) }
      update(u: ViewUpdate) { if (u.docChanged) this.decorations = this.build(u.view) }
      build(view: EditorView): DecorationSet {
        const builder = new m.RangeSetBuilder<Decoration>()
        const text = view.state.doc.toString()
        const re = /@[\w./-]+/g
        let match: RegExpExecArray | null
        while ((match = re.exec(text)) !== null) {
          const from = match.index
          const to = match.index + match[0].length
          const after = text[to]
          if (after === undefined || after === ' ' || after === '\n' || after === '\t') {
            builder.add(from, to, m.Decoration.mark({ class: 'cm-file-tag' }))
          }
        }
        return builder.finish()
      }
    }, { decorations: (v: { decorations: DecorationSet }) => v.decorations })
  }
  const state = m.EditorState.create({
    doc: props.modelValue,
    extensions: [
      m.basicSetup,
      m.cmJavascript(),
      m.oneDark,
      /* editor-no-h-scroll */
      m.EditorView.lineWrapping,
      editableComp!.of(m.EditorView.editable.of(!props.isLoopActive)),
      m.EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '12px',
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
        },
        '.cm-scroller': {
          fontFamily: 'var(--mono, monospace)',
          lineHeight: '20px',
          overflowX: 'hidden',
          overflowY: 'auto',
        },
        '.cm-content': {
          caretColor: 'var(--primary)',
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
        },
        '.cm-line': {
          color: 'var(--text)',
        },
        '.cm-gutters': {
          backgroundColor: 'var(--surface)',
          color: 'var(--text-3)',
          borderRight: '1px solid var(--border)',
        },
        '.cm-gutterElement': {
          color: 'var(--text-3)',
        },
        '.cm-lineNumbers .cm-gutterElement': {
          color: 'var(--text-3)',
        },
        '.cm-activeLine': {
          backgroundColor: 'rgb(88 166 255 / 5%)',
        },
        '.cm-activeLineGutter': {
          backgroundColor: 'rgb(88 166 255 / 8%)',
          color: 'var(--text-2)',
        },
        '.cm-cursor, .cm-dropCursor': {
          borderLeftColor: 'var(--primary)',
        },
        '.cm-selectionBackground, ::selection': {
          backgroundColor: 'rgb(88 166 255 / 25%)',
        },
        '&.cm-focused .cm-selectionBackground': {
          backgroundColor: 'rgb(88 166 255 / 30%)',
        },
        '.cm-panels': {
          backgroundColor: 'var(--surface-2)',
          color: 'var(--text)',
        },
        '.cm-tooltip': {
          backgroundColor: 'var(--surface-2)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
        },
        '&.cm-focused': {
          outline: 'none',
        },
      }, { dark: true }),
      m.Prec.highest(m.keymap.of([
        { key: 'Mod-Enter', preventDefault: true, run: () => { props.onRun?.(); return true } },
        { key: 'Alt-r', preventDefault: true, run: () => { props.onRun?.(); return true } },
        { key: 'Alt-ArrowUp', preventDefault: true, run: () => { props.onHistoryPrev?.(); return true } },
        { key: 'Alt-ArrowDown', preventDefault: true, run: () => { props.onHistoryNext?.(); return true } },

        // [enter-send-v2] 回车直接发送（Shift-Enter / Alt-Enter 走 CM 默认换行）
        { key: 'Enter', preventDefault: true, run: () => { props.onRun?.(); return true } },
        { key: 'Shift-Enter', run: () => false },
        { key: 'Alt-Enter', run: () => false },
      ])),
      m.EditorView.updateListener.of((u: ViewUpdate) => {
        if (u.docChanged) {
          emit('update:modelValue', u.state.doc.toString())
          onEditorUpdate(u)
        }
      }),
      fileTagPlugin,
    ],
  })
  cmView = new m.EditorView({ state, parent: cmHost.value })
}

watch(() => props.isLoopActive, (v) => {
  if (!cmView || !CM || !editableComp) return
  cmView.dispatch({ effects: editableComp.reconfigure(CM.EditorView.editable.of(!v)) })
})

// 外部 script 变化同步到编辑器
watch(() => props.modelValue, (v) => {
  if (!cmView) return
  const cur = cmView.state.doc.toString()
  if (cur === v) return
  cmView.dispatch({ changes: { from: 0, to: cur.length, insert: v } })
})

/**
 * 在光标处插入文本并把光标移到插入内容末尾
 * [WHY] 供父组件通过 defineExpose 调用（拖拽插入 / 附件插入）；走 CM dispatch 保证 undo 历史完整
 * [CONSTRAINT] cmView 未就绪时静默 no-op；不校验 text 是否为空
 * [CHANGE-IMPACT] 通过 defineExpose 暴露给父组件；签名变更需同步 ScriptPanel 调用点
 * @param text 待插入的字符串
 */
function insertText(text: string): void {
  if (!cmView) return
  const pos = cmView.state.selection.main.head
  cmView.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos + text.length } })
  cmView.focus()
}

defineExpose({ insertText })

onMounted(() => { void createEditor() })

onBeforeUnmount(() => {
  try { cmView?.destroy() } catch { /* ignore */ }
  cmView = null
})
</script>

<style scoped lang="scss">
:deep(.cm-file-tag) {
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: var(--radius-4);
  padding: 1px 4px;
  margin: 0 1px;
}

.editor {
  flex: 1 1 300px;
  min-height: 0;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
  background: var(--surface) !important;
  border-top: 1px solid var(--border) !important;
}

.editor.is-running {
  border-color: rgb(88 166 255 / 40%);
}

.editor :deep(.editor-body),
.editor :deep(.cm-host),
.editor :deep(.cm-editor),
.editor :deep(.cm-scroller),
.editor :deep(.editor-bar) {
  background: var(--surface-2, var(--surface-2)) !important;
  min-height: 36px !important;
}

.editor {
  background: var(--surface, var(--surface)) !important;
}

.editor :deep(.editor-body),
.editor :deep(.cm-host),
.editor :deep(.cm-editor),
.editor :deep(.cm-scroller),
.editor :deep(.cm-gutters) {
  background: var(--surface, var(--surface)) !important;
  color: var(--text-2, var(--text-2)) !important;
}

.editor :deep(.cm-activeLine) {
  background: rgb(255 255 255 / 3%) !important;
}

.editor :deep(.cm-activeLineGutter) {
  background: rgb(255 255 255 / 3%) !important;
}

.editor:focus-within {
  border-color: rgb(88 166 255 / 50%) !important;
  box-shadow: 0 0 0 3px rgb(88 166 255 / 8%) !important;
}

.editor :deep(.cm-content),
.editor :deep(.cm-gutters),
.editor :deep(.cm-scroller) {
  font-size: 12.5px !important;
  line-height: 1.6 !important;
}

/* [drag-drop-ux-v1] 悬停反馈：外发光 + 内部虚线框 + 脉冲 + 图标文案 */
.editor.is-dragging {
  border-color: rgb(88 166 255 / 70%) !important;
  box-shadow:
    0 0 0 3px rgb(88 166 255 / 16%),
    0 0 24px rgb(88 166 255 / 18%) !important;
  background: rgb(88 166 255 / 4%) !important;
}

.editor.is-dragging::after {
  content: '📎  松开鼠标以附加文件' !important;
  position: absolute !important;
  inset: 6px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: rgb(88 166 255 / 8%) !important;
  border: 2px dashed rgb(88 166 255 / 65%) !important;
  border-radius: 8px !important;
  color: var(--primary-hover, #58a6ff) !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  letter-spacing: 0.3px !important;
  pointer-events: none !important;
  z-index: 10 !important;
  animation: ai-drop-pulse 1.2s ease-in-out infinite !important;
}

@keyframes ai-drop-pulse {
  0%,
  100% {
    opacity: 0.75;
  }
  50% {
    opacity: 1;
  }
}

.editor :deep(.editor-body),
.editor :deep(.cm-host) {
  padding: 0 !important;
  margin: 0 !important;
}

.editor :deep(.cm-content) {
  background: var(--surface, var(--surface)) !important;
  padding: 8px 12px !important;
}

.editor :deep(.cm-lineNumbers .cm-gutterElement) {
  padding: 0 8px 0 4px !important;
  min-width: 36px !important;
  font-size: 11px !important;
}

.editor.card {
  flex: 0 0 300px !important;
  min-height: 0 !important;
  background: var(--surface) !important;
  border-top: 1px solid var(--border) !important;
  border-radius: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

:deep(.cm-host) {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  height: 100% !important;
  overflow: hidden !important;
}

:deep(.file-picker) {
  position: absolute !important;
  z-index: 100 !important;
  min-width: 280px !important;
  max-width: 480px !important;
  max-height: 240px !important;
  background: var(--surface-2) !important;
  border: 1px solid var(--border) !important;
  border-radius: var(--radius-8) !important;
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%) !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
}

:deep(.fp-input) {
  padding: 8px 12px !important;
  border: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  background: transparent !important;
  color: var(--text) !important;
  font: 12px/1.4 var(--mono, monospace) !important;
  outline: 0 !important;
}

:deep(.fp-list) {
  overflow-y: auto !important;
  padding: 4px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 1px !important;
}

:deep(.fp-item) {
  padding: 5px 10px !important;
  border-radius: var(--radius-4) !important;
  font-size: 12px !important;
  font-family: var(--mono, monospace) !important;
  color: var(--text-2) !important;
  cursor: pointer !important;
  white-space: nowrap !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

:deep(.fp-item:hover),
:deep(.fp-item.active) {
  background: var(--primary-bg) !important;
  color: var(--primary) !important;
}

:deep(.fp-empty) {
  padding: 12px !important;
  text-align: center !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
}

.editor .editor-bar {
  padding: 2px 8px !important;
  font-size: 11px !important;
}

.editor-body {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  position: relative !important;
}

/* [dsh-theme-editor-v1] 输入卡片对齐 dsh InputBar */
.editor.card {
  border-radius: 22px;
  background: var(--dsw-specific-input-major, var(--bg-2, rgba(127, 127, 127, 0.05)));
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.2));
  box-shadow: var(--dsw-elevation-soft, 0 1px 2px rgba(15, 17, 21, 0.06));
  color: var(--dsw-alias-label-primary, inherit);
}
.editor:focus-within {
  border-color: var(--dsw-alias-state-business-primary, #4176e6);
}
.editor :deep(.cm-content) {
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 14px;
  line-height: 1.55;
}
.editor :deep(.cm-gutters) {
  color: var(--dsw-alias-label-caption, rgba(127, 127, 127, 0.7));
  background: transparent;
  border-right: 1px solid var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.1));
}
.editor :deep(.cm-activeLine) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.06));
}
.editor :deep(.cm-activeLineGutter) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.06));
}
</style>
