<template>
  <section class="editor card" :class="{ 'is-running': isRunning, 'is-dragging': isDragging }">
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
      <!-- [file-picker-fix-v3] Teleport 到 body：.editor-body 有 overflow:hidden + 祖先含 transform，
           会让 absolute/fixed 定位被裁或错位；Teleport 后完全脱离组件树，只受视口坐标约束
           [CONSTRAINT] 因脱离 scoped 祖先链，内部选择器必须去掉 :deep 前缀改用同元素 data-v 匹配
           [CHANGE-IMPACT] pickerRef / pickerInputRef 仍指向原元素，无需改脚本逻辑 -->
      <Teleport to="body">
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
      </Teleport>
      <div ref="cmHost" class="cm-host" tabindex="0" />
    </div>
    <!-- [chat-action-bar-v1] 底部操作条：纯图标按钮，右下角对齐（Codex / CC 风） -->
    <div class="editor-actions">
      <slot name="action-bar" />
    </div>
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
}

let CM: CMModule | null = null

let cmView: import('@codemirror/view').EditorView | null = null

let editableComp: import('@codemirror/state').Compartment | null = null

let fileTagPlugin: Extension | null = null

/** dragenter 与 dragleave 的配对深度计数 */
let dragDepth = 0

/* [drag-drop-ux-v1] 文件拖入的视觉反馈 */
// WHY: 原 editor-body 只挂 dragover.prevent + drop；无 dragenter 状态，CSS .is-dragging 系死代码
// CONSTRAINT: 子元素进出会连发 dragenter/dragleave，用 dragDepth 计数抵消，归零才复位
/** 是否处于「文件悬停输入框」态 */
const isDragging = ref(false)

/** CodeMirror 编辑器容器 DOM */
const cmHost = ref<HTMLDivElement | null>(null)

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

/** 文件选择器过滤后的结果 */
const pickerFiltered = computed(() => {
  const q = pickerQuery.value.toLowerCase()
  const all = pickerFiles.value
  if (!q) return all.slice(0, 200)
  return all.filter(p => p.toLowerCase().includes(q)).slice(0, 200)
})

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

onMounted(() => { void createEditor() })

onBeforeUnmount(() => {
  try { cmView?.destroy() } catch { /* ignore */ }
  cmView = null
})

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

/**
 * 确保 CM
 */
async function ensureCM(): Promise<CMModule> {
  if (CM) return CM
  const [v, s, j, c] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/lang-javascript'),
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
  }
  return CM
}

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
      // [file-picker-fix-v2] 视口边界检测：下方空间不足则向上翻转，左右越界则贴边
      // [CONSTRAINT] coordsAtPos 返回视口坐标（非文档坐标），与 position:fixed 天然对齐
      // [CHANGE-IMPACT] 面板估算尺寸与 CSS max-height(240) / max-width(480) 保持一致
      const M = 8
      const EST_H = 240
      const EST_W = 320
      let left = coords.left
      let top = coords.bottom + 4
      if (typeof window !== 'undefined') {
        // 右侧越界 → 贴右边
        if (left + EST_W > window.innerWidth - M) {
          left = Math.max(M, window.innerWidth - EST_W - M)
        }
        // 下方空间不足 → 翻到光标上方
        if (top + EST_H > window.innerHeight - M) {
          const above = coords.top - EST_H - 4
          top = above >= M ? above : Math.max(M, window.innerHeight - EST_H - M)
        }
      }
      pickerX.value = left
      pickerY.value = top
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
      /* editor-no-h-scroll */
      m.EditorView.lineWrapping,
      // [chat-input-v1] 智能体风：placeholder 提示 Enter 发送 / Shift+Enter 换行
      m.placeholder('输入消息，Enter 发送 · Shift+Enter 换行'),
      // [no-non-null-v1] 显式空检查：editableComp 依赖 @codemirror 动态 import，失败时为 undefined；
      // 用 ! 会让 state 创建得到非法 extension 参数（静默失效）；此处提前抛出让错误位置清晰
      (editableComp ?? (() => { throw new Error('cm-editable 扩展未加载') }))
        .of(m.EditorView.editable.of(!props.isLoopActive)),
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
        // [chat-input-v7] activeLineGutter 已随 gutter 隐藏移除（此处曾配置底色，现无 DOM 承载）
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
      }, { dark: false }),
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
</script>

<style scoped lang="scss">
:deep(.cm-file-tag) {
  background: var(--primary-bg, rgb(88 166 255 / 12%));
  color: var(--primary, #58a6ff);
  border-radius: 4px;
  padding: 1px 4px;
  margin: 0 1px;
}
.editor.card {
  flex: 0 0 auto;
  min-height: 140px;
  max-height: 360px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-2, rgb(127 127 127 / 6%));
  border: 1px solid var(--border, rgb(127 127 127 / 15%));
  border-radius: 20px;
  box-shadow: 0 1px 2px rgb(15 17 21 / 4%);
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
  max-width: min(820px, calc(100% - 100px));
  width: 100%;
  margin: 8px auto 16px;
  box-sizing: border-box;
}
.editor.card.is-running {
  border-color: rgb(88 166 255 / 40%);
}
.editor.card:focus-within {
  border-color: var(--border);
  box-shadow:
    0 1px 2px rgb(15 17 21 / 6%),
    0 0 0 3px rgb(88 166 255 / 12%);
}
html[data-theme='dark'] .editor.card {
  background: rgb(127 127 127 / 8%);
  border-color: rgb(127 127 127 / 22%);
}
.editor :deep(.cm-gutters),
.editor :deep(.cm-lineNumbers),
.editor :deep(.cm-foldGutter) {
  display: none;
}
.editor :deep(.cm-editor) {
  color: var(--text, inherit);
  font-size: 14px;
  background: transparent;
}
.editor :deep(.cm-editor.cm-focused) {
  outline: none;
}
.editor :deep(.cm-scroller) {
  font-family: inherit;
  line-height: 1.6;
  overflow-x: hidden;
  overflow-y: auto;
}
.editor :deep(.cm-scroller)::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: rgb(127 127 127 / 20%);
  border-radius: 999px;
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-thumb:hover {
  background: rgb(127 127 127 / 38%);
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-track {
  background: transparent;
}
.editor :deep(.cm-content) {
  min-height: 48px;
  padding: 14px 20px;
  color: var(--text, inherit);
  font-size: 14px;
  line-height: 1.65;
  background: transparent;
  caret-color: var(--primary, #58a6ff);
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui,
    sans-serif;
}
.editor :deep(.cm-placeholder) {
  color: var(--text-3, rgb(127 127 127 / 50%));
  font-style: normal;
  pointer-events: none;
  opacity: 0.85;
}
.editor :deep(.cm-cursor),
.editor :deep(.cm-dropCursor) {
  border-left-width: 2px;
  border-left-color: var(--primary, #58a6ff);
  border-radius: 1px;
}
.editor :deep(.cm-selectionBackground),
.editor :deep(.cm-content ::selection) {
  background: rgb(88 166 255 / 18%);
}
.editor :deep(.cm-activeLine) {
  background: transparent;
}
.editor :deep(.attach-bar) {
  padding: 12px 20px 4px;
  margin: 0;
  background: transparent;
  border: 0;
  gap: 8px;
}
.editor-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 4px;
  padding: 6px 20px 12px;
}
.editor-actions :deep(.ghost-btn),
.editor-actions :deep(.primary-btn) {
  width: 32px;
  height: 32px;
  padding: 0;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.editor-actions :deep(.ghost-btn > span),
.editor-actions :deep(.primary-btn > span) {
  display: none;
}
.editor-actions :deep(.ghost-btn:hover:not(:disabled)) {
  background: rgb(127 127 127 / 12%);
  border-color: transparent;
}
.editor.is-dragging {
  border-color: rgb(88 166 255 / 70%);
  box-shadow:
    0 0 0 3px rgb(88 166 255 / 16%),
    0 0 24px rgb(88 166 255 / 18%);
  background: rgb(88 166 255 / 4%);
}
.editor.is-dragging::after {
  content: '📎  松开鼠标以附加文件';
  position: absolute;
  inset: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(88 166 255 / 8%);
  border: 2px dashed rgb(88 166 255 / 65%);
  border-radius: 8px;
  color: var(--primary-hover, #58a6ff);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.3px;
  pointer-events: none;
  z-index: 10;
  animation: ai-drop-pulse 1.2s ease-in-out infinite;
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
:deep(.cm-host) {
  flex: 1 1 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
}
.editor-body {
  flex: 1 1 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}
.file-picker {
  position: fixed;
  z-index: 9999;
  min-width: 280px;
  max-width: 480px;
  max-height: 240px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-8);
  box-shadow: 0 8px 24px rgb(0 0 0 / 40%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.fp-input {
  padding: 8px 12px;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font: 12px/1.4 var(--mono, monospace);
  outline: 0;
}
.fp-list {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.fp-item {
  flex-shrink: 0;
  min-height: 22px;
  line-height: 1.2;
  padding: 5px 10px;
  border-radius: var(--radius-4);
  font-size: 12px;
  font-family: var(--mono, monospace);
  color: var(--text-2);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fp-item:hover,
.fp-item.active {
  background: var(--primary-bg);
  color: var(--primary);
}
.fp-empty {
  padding: 12px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
}
</style>
