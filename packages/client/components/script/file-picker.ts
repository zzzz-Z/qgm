// [file-picker-v2] 从 ScriptEditor.vue 抽出的 @ 选择器逻辑：文件 + 技能双源。
// [WHY] ScriptEditor.vue 超 §4 组件 500 行限制；picker 逻辑自成体系。
//   v2 加入技能源：`@skill/<name>` 让用户按名检索 .ai-runner/skills 下全部已装技能。
// [picker-full-path-v1] v3：搜索从「只按文件名」升级为「文件名 + 完整路径」双通道，
//   支持 `components/script`（目录前缀）、`script/round`（段边界）、`client round`（多词 AND）。
//   详见 scorePath / scoreOne / scoreItem 的注释与 tests/file-picker-score.node-test.ts。
// [CONSTRAINT] cmView 由调用方 getter 注入；本模块无 CM 编译期依赖。
//   技能插入 `@skill/<name> `，与文件路径 `@<path>` 在字形上可区分（仓库根无 skill/ 目录），
//   且命中既有 `@[\\w./-]+` 芯片正则 ⇒ 无需改 CM 装饰插件。
// [CHANGE-IMPACT] 修改 deps / 返回形状须同步 ScriptEditor 装配处与模板。

// [auto-import-explicit-v1] 显式导入：vitest/tsc 没有 auto-import 插件，
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { FileNode } from '../../types'

/** 技能在 @ 选择器中的插入前缀，避免与文件路径混淆 */
export const SKILL_PICK_PREFIX = 'skill/'

/** [picker-max-items-v1] 列表最多渲染条数；超出时 UI 提示「还有 N 条未显示」 */
export const PICKER_MAX_ITEMS = 200

/** @ 选择器条目：文件与技能共用一套渲染 */
export interface PickerItem {
  kind: 'file' | 'skill'
  /** 插入编辑器的值（不含前导 @） */
  value: string
  /** 列表主展示文本 */
  label: string
  /** 次展示文本（技能用 description 摘要，文件为完整目录） */
  hint: string
  /**
   * [picker-dir-left-ellipsis-v1] 行内展示的目录（只保留尾部若干段）。
   * [WHY] 目录与文件名的差异几乎都在尾部（`…/components/script` vs `…/scripts`），
   *   从右侧截断恰好切掉有用信息；CSS 的 `direction: rtl` 能把省略号挪到左边，
   *   但会切在词中间（实测显示成 `…ckages/client/...`），所以在数据层按「段」截。
   */
  dirTail: string
  /** 悬停 tooltip（原生 title 属性） */
  title: string
}

/**
 * [picker-dir-left-ellipsis-v1] 目录只保留尾部 maxSegs 段，前面用 `…/` 提示省略。
 * [CONSTRAINT] 纯函数；段数不超过 maxSegs 时原样返回（不做无谓改动）。
 * @param dir 完整目录（不含文件名、无尾斜杠）
 * @param maxSegs 保留的尾段数
 */
export function dirTail(dir: string, maxSegs = 3): string {
  const segs = String(dir || '').split('/').filter(Boolean)
  if (segs.length <= maxSegs) return dir
  return `…/${segs.slice(-maxSegs).join('/')}`
}

/**
 * [picker-match-score-v1] 匹配评分：分数越高越靠前，0 表示不匹配。
 * [WHY] 原实现只做 `label.includes(q)` 后按「技能全在前、文件全在后」排列，
 *   输入 `pb` 匹配不到 `prompt-builder.ts`（无词首缩写），且精确命中项可能被
 *   `slice(0, 200)` 截掉 —— 用户看到的顺序与意图无关。
 * [CONSTRAINT] 纯函数、无副作用，便于单测直接断言边界（空串 / 不匹配 / 各档位）。
 * @param haystack 被搜索的文本（小写化由调用方保证）
 * @param needle 查询词（已小写化、已 trim）
 * @returns 评分；0 表示不匹配
 */
export function scoreMatch(haystack: string, needle: string): number {
  if (!needle) return 1
  const h = haystack.toLowerCase()
  const q = needle.toLowerCase()
  const idx = h.indexOf(q)
  if (idx < 0) {
    // [picker-acronym-v1] 词首缩写：pb → Prompt-Builder（取每个词的首字母）
    const initials = h.split(/[/._-]+/).filter(Boolean).map(s => s[0]).join('')
    if (initials.includes(q)) return 40
    return 0
  }
  const segs = h.split(/[/._-]+/).filter(Boolean)
  const base = h.split('/').pop() || h
  // 完全相等 > 文件名前缀 > 任意段首 > 子串
  if (h === q) return 100
  if (base === q || base.replace(/\.[^.]+$/, '') === q) return 95
  if (base.startsWith(q)) return 90
  if (segs.some(s => s.startsWith(q))) return 80
  return 50
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
   * [picker-full-path-v1] 路径评分：把「完整相对路径」当第一等 Citizen 来打分。
   * [WHY] 原实现（picker-title-fallback-v1）只在文件名不匹配时才用路径兜底，且分数打 6 折
   *   —— 用户输入 `components/script` 或 `client/utils` 这类**路径片段**时，
   *   命中项只有 ~48 分，被同一查询下成百条的「文件名命中（90 分）」压在 200 条截断线之外，
   *   体感就是「只能按文件名搜」。用户 2026-10-21 明确要求「可以支持全路径搜索」。
   * [CONSTRAINT] 分层必须与文件名分层交错成一棵**全局有序**的树（见 scoreOne）：
   *   文件名 100/95/90 ≥ 路径"整条相等/目录前缀/路径开头/段边界" 96/94/88 ≥ 文件名段首 80。
   *   单字符查询（q.length < 2）不启用「任意位置子串」档：否则输入 `s` 会把所有路径含 s 的
   *   文件全打成 72 分，纯噪音，与既有「段首匹配」语义冲突。
   * @param path 条目完整相对路径（已小写化由本函数负责）
   * @param q 查询词（已小写化、已 trim）
   * @returns 评分；0 表示路径上不匹配
   */
  function scorePath(path: string, q: string): number {
    const p = path.toLowerCase()
    if (p === q) return 100
    // 输入的就是某文件路径 → 与文件名完全相等同级
    if (p.endsWith(`/${q}`)) return 96
    // 输入是目录前缀（或路径开头）：components/script 命中其下全部文件
    if (p.startsWith(q)) return 94
    // 从某个段边界开始：script/round → .../script/round-card.vue
    if (p.includes(`/${q}`)) return 88
    // 任意位置子串（含跨段碎片，如 `nts/scri`）；单字符过泛，不启用
    if (q.length >= 2 && p.includes(q)) return 72
    return 0
  }

  /**
   * [picker-full-path-v1] 单 token 评分：文件名命中优先，其次路径命中，最后回落文件名弱命中。
   * [WHY] 顺序即优先级：`round` 时 `RoundCard.vue`（90）必须排在 `.../round/x.ts`（88）之前，
   *   而 `.../script/x.vue`（88）必须排在「中段子串 50」之前。
   * [picker-path-min-len-v1] 路径通道要求 q.length ≥ 2。
   *   [WHY] 单字符路径命中毫无选择性且会压过文件名命中：活动工作区里输入 `s`，
   *   所有 `src/` `static/` 下的文件都拿「路径开头 94」，把 `scroll-to.ts`（文件名前缀 90）
   *   挤到后面 —— 实测（2026-10-21 活实例）前 6 条全是 `401.gif` / `add3dBuildings.ts` 这类
   *   毫无关联的文件。单字符按名搜是既有体感，不该被路径通道改写。
   * [CONSTRAINT] 只对文件做路径评分：技能的 title 是「名字 · 描述\n路径」，
   *   拿去做路径匹配会把描述里的词也当路径命中，语义混乱。
   */
  function scoreOne(it: PickerItem, q: string): number {
    const byLabel = scoreMatch(it.label, q)
    if (byLabel >= 80) return byLabel
    if (it.kind === 'file' && q.length >= 2) {
      const byPath = scorePath(it.title, q)
      if (byPath > 0) return byPath
    }
    if (it.kind === 'skill') {
      // [picker-skill-value-v1] 技能插入值是 `skill/<name>`，用户会照着占位符敲 `skill/` 收窄技能列表。
      //   [WHY] 名字里既没有 `skill/`，`.ai-runner/skills/<name>/SKILL.md` 里也没有连续 `skill/`
      //   （是 `skills/`）⇒ 只查 label / title 时输入 `skill/` 恒为「无匹配」，把一个 UI 明示的前缀
      //   变成死路。这里把 value 也纳入匹配；`skill/demo` 这种整值查询直接 100 分。
      //   [注意] 实测这是**既有**缺陷（改造前的 6 折兜底同样命中不了），不是本轮引入的回归。
      const byValue = scoreMatch(it.value, q)
      if (byValue >= 80) return byValue
      const byTitle = scoreMatch(it.title, q)
      if (byTitle > 0) return Math.floor(byTitle * 0.6)
      return byValue
    }
    return byLabel
  }

  /**
   * 条目总分。
   * [multi-token] 含空格的查询按空格拆词、**全部命中才算命中**（AND），取各词最低分作总分
   *   —— 上限压到 99，保证「多词凑中」不会越过单词精确命中。
   * [WHY] 用户常写 `client round` / `script picker` 这类「目录 + 文件名」组合，
   *   旧实现按整串子串匹配，空格一出现就 0 命中。
   */
  function scoreItem(it: PickerItem, q: string): number {
    const tokens = q.split(/\s+/).filter(Boolean)
    if (tokens.length <= 1) return scoreOne(it, q)
    let min = Number.POSITIVE_INFINITY
    for (const t of tokens) {
      const s = scoreOne(it, t)
      if (!s) return 0
      if (s < min) min = s
    }
    return Math.min(99, min)
  }

  /** [picker-total-v1] 过滤后的完整命中数（未截断）；供 UI 提示「还有更多」 */
  const pickerTotal = ref(0)

  /**
   * 合并双源并按 query 过滤。
   * [CONSTRAINT] 技能优先降级为「同分 tiebreaker」——精确匹配的文件不该被不相关的技能压住。
   *   空 query 只列已装技能，避免 200 条文件铺屏把技能入口挤到看不见。
   */
  const pickerFiltered = computed<PickerItem[]>(() => {
    const q = pickerQuery.value.trim().toLowerCase()
    const fileItems: PickerItem[] = pickerFiles.value.map((p) => {
      // [picker-file-split-label-v1] label 只放文件名，目录放 hint：
      //   深层路径整串当 label 会撑爆列表宽度，且文件名被挤到右边看不见。
      const slash = p.lastIndexOf('/')
      const dir = slash >= 0 ? p.slice(0, slash) : ''
      return {
        kind: 'file' as const,
        value: p,
        label: slash >= 0 ? p.slice(slash + 1) : p,
        hint: dir,
        dirTail: dirTail(dir),
        title: p,
      }
    })
    // [picker-skill-first-v1] 空 query 只列已装技能；输入后才并行搜文件与技能。
    if (!q) { pickerTotal.value = pickerSkills.value.length; return [...pickerSkills.value] }

    const scored: Array<{ it: PickerItem, score: number }> = []
    for (const it of [...pickerSkills.value, ...fileItems]) {
      const s = scoreItem(it, q)
      if (s > 0) scored.push({ it, score: s })
    }
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (a.it.kind !== b.it.kind) return a.it.kind === 'skill' ? -1 : 1
      return a.it.label.localeCompare(b.it.label)
    })
    pickerTotal.value = scored.length
    return scored.slice(0, PICKER_MAX_ITEMS).map(s => s.it)
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
          // [picker-skill-label-v1] 与文件项对齐：label 只放技能名，路径进 hint 前缀
          label: s.name,
          hint: `技能 · ${desc.slice(0, 110)}`,
          // 技能行不展示目录（按路径搜是文件专属），title 里仍有完整路径
          dirTail: '',
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

  /**
   * [picker-hover-sync-v1] 鼠标悬停同步高亮索引。
   * [WHY] 原实现只有 @mousedown，hover 不改 pickerIndex —— 用户看到第 5 行高亮却点第 2 行，
   *   Enter 仍按旧索引插入，插入的内容与视觉焦点不一致。
   * @param i 目标索引（越界自动夹紧）
   */
  function pickerSetIndex(i: number): void {
    const n = pickerFiltered.value.length
    if (!n) return
    pickerIndex.value = Math.max(0, Math.min(n - 1, i))
  }

  /**
   * [picker-jump-v1] 跳到首/尾或翻页。
   * [WHY] 200 条结果下只有单步移动，从第 1 条到最后要按 199 次方向键。
   * @param target 目标位置：first / last / pageUp / pageDown
   */
  function pickerJump(target: 'first' | 'last' | 'pageUp' | 'pageDown'): void {
    const n = pickerFiltered.value.length
    if (!n) return
    const PAGE = 10
    if (target === 'first') pickerIndex.value = 0
    else if (target === 'last') pickerIndex.value = n - 1
    else if (target === 'pageUp') pickerSetIndex(pickerIndex.value - PAGE)
    else pickerSetIndex(pickerIndex.value + PAGE)
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
    pickerTotal,
    pickerLoadFiles,
    pickerLoadSkills,
    pickerOpenAt,
    pickerClose,
    pickerMove,
    pickerSetIndex,
    pickerJump,
    pickerConfirm,
    pickerPick,
  }
}
