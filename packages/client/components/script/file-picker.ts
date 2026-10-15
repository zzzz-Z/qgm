// [file-picker-v2] 从 ScriptEditor.vue 抽出的 @ 选择器逻辑：文件 + 技能双源。
// [WHY] ScriptEditor.vue 超 §4 组件 500 行限制；picker 逻辑自成体系。
//   v2 加入技能源：`@skill/<name>` 让用户按名检索 .ai-runner/skills 下全部已装技能。
// [CONSTRAINT] cmView 由调用方 getter 注入；本模块无 CM 编译期依赖。
//   技能插入 `@skill/<name> `，与文件路径 `@<path>` 在字形上可区分（仓库根无 skill/ 目录），
//   且命中既有 `@[\\w./-]+` 芯片正则 ⇒ 无需改 CM 装饰插件。
// [CHANGE-IMPACT] 修改 deps / 返回形状须同步 ScriptEditor 装配处与模板。

import { computed, nextTick, ref } from 'vue'
import type { FileNode } from '../../types'

/** 技能在 @ 选择器中的插入前缀，避免与文件路径混淆 */
export const SKILL_PICK_PREFIX = 'skill/'

/** @ 选择器条目：文件与技能共用一套渲染 */
export interface PickerItem {
  kind: 'file' | 'skill'
  /** 插入编辑器的值（不含前导 @） */
  value: string
  /** 列表主展示文本 */
  label: string
  /** 次展示文本（技能用 description 摘要，文件留空） */
  hint: string
  /** 悬停 tooltip（原生 title 属性） */
  title: string
}

interface UseFilePickerDeps {
  getCmView: () => import('@codemirror/view').EditorView | null
}

interface SkillMeta {
  name: string
  description?: string
  path?: string
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
  const pickerSkills = ref<PickerItem[]>([])

  const pickerStyle = computed(() => ({ left: `${pickerX.value}px`, top: `${pickerY.value}px` }))

  /**
   * 合并双源并按 query 过滤。
   * [CONSTRAINT] 技能优先于文件（同名场景下技能是更明确的意图）；各源独立截断，避免文件树挤掉技能。
   */
  const pickerFiltered = computed<PickerItem[]>(() => {
    const q = pickerQuery.value.toLowerCase()
    const fileItems: PickerItem[] = pickerFiles.value.map(p => ({
      kind: 'file',
      value: p,
      label: p,
      hint: '',
      title: p,
    }))
    // [picker-skill-first-v1] 空 query 只列已装技能；输入后才并行搜文件与技能，
    //   否则 200 条文件铺屏会把技能入口挤到看不见。
    if (!q) return [...pickerSkills.value]
    const all = [...pickerSkills.value, ...fileItems]
    return all
      .filter(it => it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q))
      .slice(0, 200)
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

  /**
   * 拉取已装技能清单（磁盘为准）。
   * [WHY] 与文件树同批加载：用户敲 @ 时两条路径都已就绪，无需二次等待。
   * [CONSTRAINT] 失败降级为空数组——技能不可用不应阻断文件检索。
   */
  async function pickerLoadSkills() {
    if (pickerSkills.value.length) return
    try {
      const res = await fetch('/__ai/skills', { headers: { accept: 'application/json' } })
      const data = await res.json() as { ok?: boolean, skills?: SkillMeta[] }
      pickerSkills.value = (data.skills || []).map((s) => {
        const rel = s.path || `.ai-runner/skills/${s.name}/SKILL.md`
        const desc = String(s.description || '').replace(/\s+/g, ' ').trim()
        return {
          kind: 'skill' as const,
          value: `${SKILL_PICK_PREFIX}${s.name}`,
          label: rel,
          hint: desc.slice(0, 120),
          title: `${s.name}${desc ? ` · ${desc}` : ''}\n${rel}`,
        }
      })
    } catch { pickerSkills.value = [] }
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
        const EST_W = 380
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
    void pickerLoadSkills()
    nextTick(() => pickerInputRef.value?.focus())
  }

  function pickerClose() {
    pickerOpen.value = false
    pickerQuery.value = ''
    pickerIndex.value = 0
  }

  // [picker-outside-close-v1] 点击 picker 外部关闭（Esc 之外的第二条出口）；capture 阶段先于
  //   元素 onmousedown，命中列表项时 el.contains(target) 为真 → 不关，避免误杀选择动作。
  function onDocMousedown(e: MouseEvent) {
    const el = pickerRef.value
    if (!el) return
    const t = e.target as Node | null
    if (t && el.contains(t)) return
    pickerClose()
  }
  watch(pickerOpen, (v) => {
    if (typeof document === 'undefined') return
    if (v) document.addEventListener('mousedown', onDocMousedown, true)
    else document.removeEventListener('mousedown', onDocMousedown, true)
  })
  onBeforeUnmount(() => {
    if (typeof document !== 'undefined') document.removeEventListener('mousedown', onDocMousedown, true)
  })

  function pickerMove(d: number) {
    const n = pickerFiltered.value.length
    if (!n) return
    pickerIndex.value = (pickerIndex.value + d + n) % n
  }

  function pickerConfirm() {
    const it = pickerFiltered.value[pickerIndex.value]
    if (it) pickerPick(it)
  }

  function pickerPick(item: PickerItem) {
    const cmView = getCmView()
    if (!cmView) return
    pickerOpen.value = false
    const insertText = `@${item.value} `
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
    pickerSkills,
    pickerStyle,
    pickerFiltered,
    pickerLoadFiles,
    pickerLoadSkills,
    pickerOpenAt,
    pickerClose,
    pickerMove,
    pickerConfirm,
    pickerPick,
  }
}
