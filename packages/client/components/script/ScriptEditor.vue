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
  background: var(--primary-bg, rgba(88, 166, 255, 0.12));
  color: var(--primary, #58a6ff);
  border-radius: 4px;
  padding: 1px 4px;
  margin: 0 1px;
}

/* [chat-action-bar-v1] 底部操作条：无背景、右下角对齐，图标按钮紧贴输入框右下 */
.editor-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 6px;
  padding: 4px 10px 10px;
  flex-shrink: 0;
}

/* [chat-input-v3] 智能体聊天输入框风：大圆角 + 淡背景 + 高度自适应 */
.editor.card {
  flex: 0 0 auto !important;
  min-height: 140px !important;
  max-height: 360px !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  background: var(--surface-2, rgba(127, 127, 127, 0.06)) !important;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.15)) !important;
  border-radius: 20px !important;
  box-shadow: 0 1px 2px rgba(15, 17, 21, 0.04) !important;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease !important;
}

.editor.card.is-running {
  border-color: rgba(88, 166, 255, 0.4) !important;
}

.editor.card:focus-within {
  border-color: rgba(88, 166, 255, 0.55) !important;
  box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.1) !important;
}

/* 隐藏行号 / gutter / 折叠等代码编辑器特征，对齐聊天输入框观感 */
.editor :deep(.cm-gutters),
.editor :deep(.cm-lineNumbers),
.editor :deep(.cm-foldGutter) {
  display: none !important;
}

.editor :deep(.cm-editor) {
  color: var(--text, inherit) !important;
  font-size: 14px !important;
  background: transparent !important;
}

.editor :deep(.cm-editor.cm-focused) {
  outline: none !important;
}

.editor :deep(.cm-scroller) {
  font-family: inherit !important;
  line-height: 1.6 !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
}

.editor :deep(.cm-content) {
  min-height: 48px !important;
  // [pad-align-v4] 同改 20px 消除残留（chat-list 实际水平 padding 为 20px）
  padding: 14px 20px !important;
  color: var(--text, inherit) !important;
  font-size: 14px !important;
  line-height: 1.65 !important;
  background: transparent !important;
  caret-color: var(--primary, #58a6ff) !important;
  // [chat-input-v6] basicSetup 默认给 .cm-content 上 monospace，聊天输入框改系统 UI 字体
  font-family:
    -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', system-ui,
    sans-serif !important;
}

/* [chat-input-v6] 滚动条更细更淡，减少视觉噪音 */
.editor :deep(.cm-scroller)::-webkit-scrollbar {
  width: 5px;
  height: 5px;
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: rgba(127, 127, 127, 0.22);
  border-radius: 999px;
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-thumb:hover {
  background: rgba(127, 127, 127, 0.38);
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-track {
  background: transparent;
}

// [chat-input-v3] placeholder 柔和色，弱化提示但不抢视觉
.editor :deep(.cm-placeholder) {
  color: var(--text-3, rgba(127, 127, 127, 0.55)) !important;
  font-style: normal !important;
  pointer-events: none !important;
}

// [chat-input-v7] activeLineGutter 已随 gutter display:none 失效，仅保留 activeLine
.editor :deep(.cm-activeLine) {
  background: transparent !important;
}

.editor :deep(.cm-selectionBackground),
.editor :deep(.cm-content ::selection) {
  background: rgba(88, 166, 255, 0.22) !important;
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

:deep(.cm-host) {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  height: 100% !important;
  overflow: hidden !important;
}

.file-picker {
  /* [file-picker-fix-v2] 改 absolute → fixed：.editor-body 有 overflow:hidden，
   * 当光标贴近编辑器底部时向下弹出会被裁切，出现"只显示一半"的症状；
   * fixed + 视口坐标（coordsAtPos 返回的即视口坐标）可完全规避该裁切
   * z-index 提到 9999，避免被其他浮层（Tooltip/Toast）遮挡 */
  position: fixed !important;
  z-index: 9999 !important;
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

.fp-input {
  padding: 8px 12px !important;
  border: 0 !important;
  border-bottom: 1px solid var(--border) !important;
  background: transparent !important;
  color: var(--text) !important;
  font: 12px/1.4 var(--mono, monospace) !important;
  outline: 0 !important;
}

.fp-list {
  /* [file-picker-fix-v1] flex column 子项必须显式声明 flex-grow 与 min-height:0，
   * 否则在父级 max-height + overflow:hidden 下会被压扁至内容塌陷，列表项渲染成灰色条 */
  flex: 1 1 auto !important;
  min-height: 0 !important;
  overflow-y: auto !important;
  padding: 4px !important;
  display: flex !important;
  flex-direction: column !important;
  gap: 1px !important;
}

.fp-item {
  /* [file-picker-fix-v1] 阻止 flex column 收缩项高度；最小行高兜底避免被压缩成灰色条 */
  flex-shrink: 0 !important;
  min-height: 22px !important;
  line-height: 1.2 !important;
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

.fp-item:hover,
.fp-item.active {
  background: var(--primary-bg) !important;
  color: var(--primary) !important;
}

.fp-empty {
  padding: 12px !important;
  text-align: center !important;
  color: var(--text-3) !important;
  font-size: 12px !important;
}

.editor-body {
  flex: 1 1 0 !important;
  min-height: 0 !important;
  display: flex !important;
  flex-direction: column !important;
  overflow: hidden !important;
  position: relative !important;
}

/* ============================================================
 * [editor-polish-v1] 输入框精修 v2
 * [WHY] v1 已完成聊天框结构改造；本层针对光标、附件条衔接、底部按钮区、焦点过渡做视觉精修
 * [CONSTRAINT] 全部 !important 覆盖 v1；不改结构；纯视觉参数
 * [CHANGE-IMPACT] 与 [chat-input-v3] / [chat-action-bar-v1] 同层叠加，改动集中便于回滚
 * ============================================================ */

/* ① 光标：柔和 2px 竖条 + 呼吸动画，比默认 1px 更醒目 */
.editor :deep(.cm-cursor),
.editor :deep(.cm-dropCursor) {
  border-left-width: 2px !important;
  border-left-color: var(--primary, #58a6ff) !important;
  border-radius: 1px !important;
}

/* ② 输入区内边距：左右与信息区 chat-list 的实际水平 padding 对齐 */
/* [pad-align-v4] chat-list 后续规则已把水平 padding 由 24px 覆盖为 20px，
 * 输入框此前仍按 24px 计算，文字比消息文字内缩 4px；改 20px 归位。 */
.editor :deep(.cm-content) {
  // [pad-align-v4] 左右 20px 对齐 chat-list；上下 14px 保持紧凑
  padding: 14px 20px !important;
}

/* ③ 选区：更透明、更柔和，不遮挡字 */
.editor :deep(.cm-selectionBackground),
.editor :deep(.cm-content ::selection) {
  background: rgba(88, 166, 255, 0.18) !important;
}

/* ④ 附件条：无边框无底色，仅在内容与输入区之间留 8px 视觉缝 */
.editor :deep(.attach-bar) {
  // [pad-align-v4] 左右 20px 对齐 chat-list（原 24px 已过时）
  padding: 12px 20px 4px !important;
  margin: 0 !important;
  background: transparent !important;
  border: 0 !important;
  gap: 8px !important;
}

/* ⑤ 底部按钮区：贴右下角，hover 更明显 */
.editor-actions {
  // [pad-align-v4] 左右 20px 对齐 chat-list（原 24px 已过时）
  padding: 6px 20px 12px !important;
  gap: 4px !important;
  justify-content: flex-end !important;
  align-items: center !important;
}
.editor-actions :deep(.ghost-btn),
.editor-actions :deep(.primary-btn) {
  width: 32px !important;
  height: 32px !important;
  padding: 0 !important;
  border-radius: 8px !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}
.editor-actions :deep(.ghost-btn > span),
.editor-actions :deep(.primary-btn > span) {
  display: none !important;
}
.editor-actions :deep(.ghost-btn:hover:not(:disabled)) {
  background: rgba(127, 127, 127, 0.12) !important;
  border-color: transparent !important;
}

/* ⑥ 焦点态：光晕更柔和，无需边框加亮 */
.editor.card:focus-within {
  border-color: var(--border) !important;
  box-shadow:
    0 1px 2px rgba(15, 17, 21, 0.06),
    0 0 0 3px rgba(88, 166, 255, 0.12) !important;
}

/* ⑦ 暗色模式：背景对比稍强，卡片浮起更明显 */
html[data-theme='dark'] .editor.card {
  background: rgba(127, 127, 127, 0.08) !important;
  border-color: rgba(127, 127, 127, 0.22) !important;
}

/* ⑧ 滚动条更细，指尖划过不刺眼 */
.editor :deep(.cm-scroller)::-webkit-scrollbar {
  width: 5px !important;
}
.editor :deep(.cm-scroller)::-webkit-scrollbar-thumb {
  background: rgba(127, 127, 127, 0.2) !important;
  border-radius: 999px !important;
}

/* ⑨ placeholder 呼吸：淡化处理，不与正文抢视觉 */
.editor :deep(.cm-placeholder) {
  color: var(--text-3, rgba(127, 127, 127, 0.5)) !important;
  opacity: 0.85 !important;
}

/* ============================================================
 * [pad-align-v2] 输入卡片与展示区宽度对齐
 * [WHY] 展示区 .chat-list 有 max-width:820px 居中；输入卡片 .editor.card 却全宽拉伸 →
 *       两侧左右边界不一致，视觉割裂。本层让输入卡片对齐 820px 并居中。
 * [CONSTRAINT] .editor.card 是 pane-main（flex column）的直接子项；靠 max-width + margin auto 居中；
 *              width:100% 保证窄屏下缩到父容器宽度，不溢出。
 * [CHANGE-IMPACT] 与 [chat-input-v3] 的 flex 布局叠加；若后续改 pane-main 的 align-items 需同步复核。
 * ============================================================ */

.editor.card {
  /* [pad-align-v5] chat-list 由 .terminal 的 50px 水平内边距包裹；卡片直接挂 .pane-main。
     宽屏（pane-main ≥ 920px）两侧都是 820px 居中 → 边缘一致；
     窄屏（pane-main < 920px）chat-list 因 .terminal padding 内缩 50px，而卡片贴 pane 边 → 左右错位。
     min(820px, 100% - 100px) 宽屏保持 820 居中、窄屏自动同步内缩 50px，两端边缘严格对齐。 */
  max-width: min(820px, calc(100% - 100px)) !important;
  width: 100% !important;
  margin: 8px auto 16px !important;
  box-sizing: border-box !important;
}
</style>
