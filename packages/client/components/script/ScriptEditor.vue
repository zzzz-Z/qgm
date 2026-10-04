<script setup lang="ts">
import { useFilePicker } from './file-picker'
import type { Decoration, DecorationSet, EditorView, ViewUpdate } from '@codemirror/view'

// CM 动态 import 聚合类型：从各包具名导出反推，杜绝 any
interface CMModule {
  EditorView: typeof import('@codemirror/view').EditorView
  keymap: typeof import('@codemirror/view').keymap
  placeholder: typeof import('@codemirror/view').placeholder
  Decoration: typeof import('@codemirror/view').Decoration
  WidgetType: typeof import('@codemirror/view').WidgetType
  ViewPlugin: typeof import('@codemirror/view').ViewPlugin
  EditorState: typeof import('@codemirror/state').EditorState
  Prec: typeof import('@codemirror/state').Prec
  Compartment: typeof import('@codemirror/state').Compartment
  RangeSetBuilder: typeof import('@codemirror/state').RangeSetBuilder
  basicSetup: typeof import('codemirror').basicSetup
  cmJavascript: typeof import('@codemirror/lang-javascript').javascript
}

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

let CM: CMModule | null = null
let cmView: import('@codemirror/view').EditorView | null = null
let editableComp: import('@codemirror/state').Compartment | null = null
let fileTagPlugin: import('@codemirror/view').ViewPlugin<{ decorations: DecorationSet }> | null = null
/** dragenter 与 dragleave 的配对深度计数 */
let dragDepth = 0

/* 文件拖入的视觉反馈 */
// WHY: 原 editor-body 只挂 dragover.prevent + drop；无 dragenter 状态，CSS .is-dragging 系死代码
// CONSTRAINT: 子元素进出会连发 dragenter/dragleave，用 dragDepth 计数抵消，归零才复位
/** 是否处于「文件悬停输入框」态 */
const isDragging = ref(false)
/** CodeMirror 编辑器容器 DOM */
const cmHost = ref<HTMLDivElement | null>(null)

// [file-picker-v1] @ 文件选择器逻辑已抽到 file-picker.ts；本组件只持有实例
const {
  pickerOpen,
  pickerQuery,
  pickerIndex,
  pickerPos,
  pickerAnchor,
  pickerX,
  pickerY,
  pickerRef,
  pickerInputRef,
  pickerFiles,
  pickerStyle,
  pickerFiltered,
  pickerLoadFiles,
  pickerOpenAt,
  pickerClose,
  pickerMove,
  pickerConfirm,
  pickerPick,
} = useFilePicker({ getCmView: () => cmView })

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
    WidgetType: v.WidgetType,
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
  // Trae 风 @引用芯片：把 @路径 整段替换为「类型角标 + 文件名」控件
  // [WHY] 与附件芯片视觉统一；隐藏冗长路径，避免挤占输入区
  // [CONSTRAINT] 仅替换「显示」，文档内仍是 @路径 原文，发送/解析逻辑零影响
  // [CHANGE-IMPACT] 需配合下方 atomicRanges，否则光标可落入不可见区间
  class FileChipWidget extends m.WidgetType {
    constructor(
      readonly badge: string,
      readonly label: string,
      readonly full: string,
    ) { super() }

    override eq(other: FileChipWidget) {
      return other.badge === this.badge && other.label === this.label && other.full === this.full
    }

    toDOM() {
      const el = document.createElement('span')
      el.className = 'cm-file-chip'
      el.title = `@${this.full}`
      const badge = document.createElement('span')
      badge.className = 'cm-file-chip-badge'
      badge.textContent = this.badge
      const tone = fileToneStyle(this.label)
      badge.style.color = tone.color
      badge.style.background = tone.background
      const name = document.createElement('span')
      name.className = 'cm-file-chip-name'
      name.textContent = this.label
      el.append(badge, name)
      return el
    }
  }
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
            const path = match[0].slice(1)
            const label = path.split('/').pop() || path
            builder.add(from, to, m.Decoration.replace({ widget: new FileChipWidget(fileBadge(label), label, path) }))
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
      // 智能体风：placeholder 提示 Enter 发送 / Shift+Enter 换行
      m.placeholder('输入消息…  Enter 发送 / Shift+Enter 换行'),
      // 显式空检查：editableComp 依赖 @codemirror 动态 import，失败时为 undefined；
      // 用 ! 会让 state 创建得到非法 extension 参数（静默失效）；此处提前抛出让错误位置清晰
      (editableComp ?? (() => { throw new Error('cm-editable 扩展未加载') }))
        .of(m.EditorView.editable.of(!props.isLoopActive)),
      m.EditorView.theme({
        '&': {
          height: '100%',
          fontSize: '13px',
          backgroundColor: 'var(--surface)',
          color: 'var(--text)',
        },
        '.cm-scroller': {
          fontFamily: 'var(--mono, monospace)',
          lineHeight: '19px',
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
        // activeLineGutter 已随 gutter 隐藏移除（此处曾配置底色，现无 DOM 承载）
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

        // 回车直接发送（Shift-Enter / Alt-Enter 走 CM 默认换行）
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
      // @引用芯片是 replace 装饰，需声明为原子区间，光标/选区整体跳过不可见原文
      m.EditorView.atomicRanges.of((view: EditorView) => {
        const inst = fileTagPlugin ? view.plugin(fileTagPlugin) : null
        return inst?.decorations ?? m.Decoration.none
      }),
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
      <!-- Teleport 到 body：.editor-body 有 overflow:hidden + 祖先含 transform，
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
    <!-- 底部操作条：纯图标按钮，右下角对齐（Codex / CC 风） -->
    <div class="editor-actions">
      <slot name="action-bar" />
    </div>
  </section>
</template>

<style scoped lang="scss" src="./script-editor.scss"></style>
