// [file-picker-v1] 从 ScriptEditor.vue 抽出的 @ 文件选择器逻辑
// [WHY] ScriptEditor.vue 超 §4 组件 500 行限制；picker 逻辑自成体系
// [CONSTRAINT] cmView 由调用方 getter 注入；本模块无 CM 编译期依赖
// [CHANGE-IMPACT] 修改 deps 须同步 ScriptEditor 装配处

import { computed, nextTick, ref } from 'vue'
import type { FileNode } from '../../types'

interface UseFilePickerDeps {
  getCmView: () => import('@codemirror/view').EditorView | null
}

export function useFilePicker(deps: UseFilePickerDeps) {
  const { getCmView } = deps

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
  const pickerFiltered = computed(() => {
    const q = pickerQuery.value.toLowerCase()
    const all = pickerFiles.value
    if (!q) return all.slice(0, 200)
    return all.filter(p => p.toLowerCase().includes(q)).slice(0, 200)
  })

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

  function pickerOpenAt(atPos: number) {
    pickerOpen.value = true
    pickerQuery.value = ''
    pickerIndex.value = 0
    pickerPos.value = atPos
    pickerAnchor.value = atPos + 1
    const cmView = getCmView()
    if (cmView) {
      const coords = cmView.coordsAtPos(atPos)
      if (coords) {
        const M = 8
        const EST_H = 240
        const EST_W = 320
        let left = coords.left
        let top = coords.bottom + 4
        if (typeof window !== 'undefined') {
          if (left + EST_W > window.innerWidth - M) {
            left = Math.max(M, window.innerWidth - EST_W - M)
          }
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
    const cmView = getCmView()
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

  return {
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
  }
}
