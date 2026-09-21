<template>
  <section class="editor card" :class="{ 'is-running': isRunning }">
    <slot name="tpl-bar" />
    <slot name="attach-bar" />
    <div class="editor-body" @paste.capture="(e) => emit('paste', e)" @dragover.prevent @drop="(e) => emit('drop', e)">
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

const props = defineProps<{
  modelValue: string
  isRunning: boolean
  isLoopActive: boolean
  onRun?: () => boolean | void
  onHistoryPrev?: () => void
  onHistoryNext?: () => void
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  'paste': [e: ClipboardEvent]
  'drop': [e: DragEvent]
}>()

// ---------- CodeMirror 动态加载 ----------
let CM: any = null
async function ensureCM(): Promise<any> {
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
    basicSetup: (c as any).basicSetup,
    cmJavascript: j.javascript,
    oneDark: t.oneDark,
  }
  return CM
}

// ---------- editor 状态 ----------
const cmHost = ref<HTMLDivElement | null>(null)
let cmView: any = null
let editableComp: any = null

// ---------- file picker ----------
/* @FILE_PICKER_V1 */
const pickerOpen = ref(false)
const pickerQuery = ref('')
const pickerIndex = ref(0)
const pickerPos = ref(0)
const pickerAnchor = ref(0)
const pickerX = ref(0)
const pickerY = ref(0)
const pickerRef = ref<HTMLDivElement | null>(null)
const pickerInputRef = ref<HTMLInputElement | null>(null)
const pickerFiles = ref<string[]>([])
const pickerStyle = computed(() => ({ left: `${pickerX.value}px`, top: `${pickerY.value}px` }))

async function pickerLoadFiles() {
  if (pickerFiles.value.length) return
  try {
    const res = await fetch('/__ai/files?depth=6')
    const data = await res.json()
    const flat: string[] = []
    const walk = (nodes: any[]) => {
      for (const n of nodes || []) {
        if (n.type === 'file') flat.push(n.path)
        else if (n.children) walk(n.children)
      }
    }
    walk(data.tree || [])
    pickerFiles.value = flat
  } catch { pickerFiles.value = [] }
}

const pickerFiltered = computed(() => {
  const q = pickerQuery.value.toLowerCase()
  const all = pickerFiles.value
  if (!q) return all.slice(0, 200)
  return all.filter(p => p.toLowerCase().includes(q)).slice(0, 200)
})

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

function pickerClose() {
  pickerOpen.value = false
  pickerQuery.value = ''
  pickerIndex.value = 0
}

function pickerMove(d: number) {
  const n = pickerFiltered.value.length
  if (!n) return
  pickerIndex.value = (pickerIndex.value + d + n) % n
}

function pickerConfirm() {
  const f = pickerFiltered.value[pickerIndex.value]
  if (f) pickerPick(f)
}

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

// ---------- 编辑器事件 ----------
function onEditorUpdate(u: any) {
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

// ---------- 编辑器创建 ----------
let fileTagPlugin: any = null
async function createEditor() {
  if (!cmHost.value || cmView) return
  const m = await ensureCM()
  if (!editableComp) editableComp = new m.Compartment()
  if (!fileTagPlugin) {
    fileTagPlugin = m.ViewPlugin.fromClass(class {
      decorations: any
      constructor(view: any) { this.decorations = this.build(view) }
      update(u: any) { if (u.docChanged) this.decorations = this.build(u.view) }
      build(view: any) {
        const builder = new m.RangeSetBuilder()
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
    }, { decorations: (v: any) => v.decorations })
  }
  const state = m.EditorState.create({
    doc: props.modelValue,
    extensions: [
      m.basicSetup,
      m.cmJavascript(),
      m.oneDark,
      /* editor-no-h-scroll */
      m.EditorView.lineWrapping,
      editableComp.of(m.EditorView.editable.of(!props.isLoopActive)),
      m.placeholder('写脚本，或 !命令 走 shell · @问题 发给 AI · ⌘/Ctrl + ↵ 运行'),
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

        {
          key: 'Enter',
          run: () => {
            const text = props.modelValue.trim()
            if (text.startsWith('!') && !text.includes('\n')) {
              props.onRun?.()
              return true
            }
            return false
          }
        },
      ])),
      m.EditorView.updateListener.of((u: any) => {
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

// ---------- 循环态切换只读 ----------
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
  padding: 6px 12px !important;
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

.editor.is-dragging {
  border-color: rgb(88 166 255 / 60%) !important;
  box-shadow: 0 0 0 3px rgb(88 166 255 / 12%) !important;
  background: rgb(88 166 255 / 4%) !important;
}

.editor.is-dragging::after {
  content: '松开以附加文件' !important;
  position: absolute !important;
  inset: 0 !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
  background: rgb(88 166 255 / 8%) !important;
  color: var(--primary-hover) !important;
  font-size: 13px !important;
  font-weight: 600 !important;
  pointer-events: none !important;
  z-index: 10 !important;
  border-radius: inherit !important;
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
</style>
