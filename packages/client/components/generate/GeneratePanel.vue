<script setup lang="ts">
// [generate-panel-utils-extracted]
import { formatRepoSummary } from './generate-panel-utils'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FileTree from '../panels/FileTree.vue'
import { copyAndFill, sendNewSession } from '../../composables/ai/useDeepseekUrl'
import { useAiWaiting } from '../../composables/ai/useAiWaiting'
import { useCodeCleaner } from '../../composables/runner/useCodeCleaner'
import { buildFullContext, enforceBudget } from '../../utils/contextBuilder'
import { useToast } from '../../composables/ui/useToast'
import { useTraceLog } from '../../composables/ui/useTraceLog'
import { useSessionManager } from '../../composables/ai/useSessionManager'
import type { FilesReadResponse } from '../../types'

defineOptions({ name: 'GeneratePanel' })

/** 派发 */
const emit = defineEmits<{ sent: [] }>()

interface FileEntry {
  path: string
  content?: string
  error?: string
  loading?: boolean
  justAdded?: boolean
}

/** Markdown 代码围栏标记 */
const FENCE = '```'

/** 编辑器 */
const editorRef = ref<HTMLDivElement>()
/** 文件 */
const files = ref<FileEntry[]>([])
/** 是否正在拖拽 */
const dragging = ref(false)
/** 信息 */
const dragInfo = ref<{ count: number, type: string } | null>(null)
/** 成功 */
const success = ref(false)
/** 成功数量 */
const successCount = ref(0)
/** 是否已复制到剪贴板 */
const copied = ref(false)

const { waiting: aiWaiting, startWaiting: startAiWaiting } = useAiWaiting()

// 检索相关
/** 搜索关键词 */
const searchQuery = ref('')
/** 搜索的 glob 模式（限定文件范围） */
const searchGlob = ref('')
/** 模式 */
const searchMode = ref<'content' | 'file' | 'ast'>('content')
/** 搜索限定的语言 */
const searchLang = ref('typescript')
/** 搜索进行中标志 */
const searching = ref(false)
/** 搜索结果列表 */
const searchResults = ref<Array<{ path: string, line?: number, text?: string }>>([])
/** 错误 */
const searchError = ref('')
/** 显示 */
const showSearch = ref(false)
/** 是否正在批量添加全部结果 */
const addingAll = ref(false)
/** 键 */
const KEY_PLAN = '__ai_plan_mode'

/**
 * 加载 Plan Mode
 */
function loadPlanMode(): boolean {
  try { return localStorage.getItem(KEY_PLAN) === '1' } catch { return false }
}
/** 模式 */
const planMode = ref(loadPlanMode())
watch(planMode, (v) => {
  try { localStorage.setItem(KEY_PLAN, v ? '1' : '0') } catch { }
})
let searchReqId = 0

// 代码清洗（开关从全局 composable 读）
const { stripComments, stripBlankLines } = useCodeCleaner()
const { toast } = useToast()
const { addTrace } = useTraceLog()
const { maybeRotateSession: rotateViaSM } = useSessionManager()
/** 文本 */
const questionText = ref('')

// Skills
interface Skill { name: string, content: string, source?: 'base' | 'user' }
/** skill 列表 */
const skills = ref<Skill[]>([])
/** 已选中 */
const selectedSkills = ref<string[]>(loadSelectedSkills())
/** 显示 */
const showSkills = ref(false)
/** 名称 */
const newSkillName = ref('')
/** 新建 skill 的初始内容 */
const newSkillContent = ref('')
/** 是否正在创建 skill */
const creatingSkill = ref(false)

// [OPT] skill default + select-all
// 常驻默认：每轮必读的核心规则（对齐后端 _loader.cjs ALWAYS_KEYS）
const DEFAULT_SKILLS: string[] = [
  'core-behavior',
  'core-loop-protocol',
  'script-standards',
  'env-preflight',
  'script-ai-api',
]

/**
 * 加载 Selected Skills
 */
function loadSelectedSkills(): string[] {
  try {
    const raw = localStorage.getItem('__ai_selected_skills')
    if (raw === null) return DEFAULT_SKILLS.slice()
    return JSON.parse(raw)
  } catch { return DEFAULT_SKILLS.slice() }
}

watch(selectedSkills, (v) => {
  try { localStorage.setItem('__ai_selected_skills', JSON.stringify(v)) } catch { /* ignore */ }
}, { deep: true })

/**
 * 加载 Skills
 */
async function loadSkills() {
  try {
    const res = await fetch('/__ai/skills')
    const data = await res.json()
    skills.value = Array.isArray(data) ? data : []
    // 过滤已删除的选中项
    const names = new Set(skills.value.map(s => s.name))
    selectedSkills.value = selectedSkills.value.filter(n => names.has(n))
  } catch { skills.value = [] }
}

/**
 * 创建 Skill
 */
async function createSkill() {
  const name = newSkillName.value.trim()
  const content = newSkillContent.value.trim()
  if (!name || !content) return
  creatingSkill.value = true
  try {
    const res = await fetch('/__ai/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content }),
    })
    const data = await res.json()
    if (!data.ok) { toast(data.error || '保存失败', 'error'); return }
    newSkillName.value = ''
    newSkillContent.value = ''
    await loadSkills()
  } catch (e) { toast(String(e), 'error') }
  finally { creatingSkill.value = false }
}

/**
 * 删除 Skill
 * @param name - name
 */
async function deleteSkill(name: string) {
  await fetch(`/__ai/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
  selectedSkills.value = selectedSkills.value.filter(s => s !== name)
  await loadSkills()
}

/**
 * 切换 Skill
 * @param name - name
 */
function toggleSkill(name: string) {
  const i = selectedSkills.value.indexOf(name)
  if (i >= 0) selectedSkills.value.splice(i, 1)
  else selectedSkills.value.push(name)
}

/**
 * 执行 select All Skills
 */
function selectAllSkills() {
  selectedSkills.value = skills.value.map(s => s.name)
}

/**
 * 清空 All Skills
 */
function clearAllSkills() {
  selectedSkills.value = []
}

// 立即加载（不依赖 onMounted，避开不同版本差异）
loadSkills()

// @ 提及
/** 可见的 */
const atVisible = ref(false)
/** @ 弹出菜单的检索关键词 */
const atQuery = ref('')
/** @ 检索命中的文件列表 */
const atResults = ref<Array<{ path: string }>>([])
/** @ 弹出菜单的定位矩形 */
const atRect = ref<{ top: number, left: number } | null>(null)
/** 索引 */
const atIndex = ref(0)
/** 加载中 */
const atLoading = ref(false)
/** 是否为 */
const isComposing = ref(false)
let atStartOffset = -1
let atReqId = 0

/**
 * 执行 sync Question
 */
function syncQuestion() {
  questionText.value = editorRef.value?.innerText?.trim() || ''
}
/** 键 */
const KEY_QUESTION = '__ai_generate_question'
/** 键 */
const KEY_PATHS = '__ai_generate_paths'
let saveQuestionTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 执行 save Question Now
 */
function saveQuestionNow() {
  if (!editorRef.value) return
  try {
    const html = editorRef.value.innerHTML
    if (html) localStorage.setItem(KEY_QUESTION, html)
    else localStorage.removeItem(KEY_QUESTION)
  } catch { }
}
/**
 * 执行 save Question
 */
function saveQuestion() {
  if (saveQuestionTimer) clearTimeout(saveQuestionTimer)
  saveQuestionTimer = setTimeout(saveQuestionNow, 300)
}
/**
 * 加载 Question
 */
function loadQuestion(): string {
  try { return localStorage.getItem(KEY_QUESTION) || '' } catch { return '' }
}
/**
 * 加载 Paths
 */
function loadPaths(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY_PATHS)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}
watch(
  () => files.value.map(f => f.path).join('\n'),
  (s) => {
    try {
      const paths = s ? s.split('\n').filter(Boolean) : []
      if (paths.length) sessionStorage.setItem(KEY_PATHS, JSON.stringify(paths))
      else sessionStorage.removeItem(KEY_PATHS)
    } catch { }
  },
)

/**
 * 检测 At
 */
function detectAt(): { query: string, startOffset: number } | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const text = node.textContent || ''
  const offset = range.startOffset
  let i = offset - 1
  while (i >= 0) {
    const ch = text[i]
    if (ch === '@') {
      const query = text.slice(i + 1, offset)
      if (/[\s@]/.test(query)) return null
      return { query, startOffset: i }
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

/**
 * 响应 Editor Input
 */
function onEditorInput() {
  syncQuestion()
  saveQuestion()
  if (isComposing.value) return
  const det = detectAt()
  if (!det) { atVisible.value = false; return }
  atStartOffset = det.startOffset
  atQuery.value = det.query
  const sel = window.getSelection()
  if (sel && sel.rangeCount) {
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    atRect.value = { top: rect.bottom + 4, left: rect.left }
  }
  atVisible.value = true
  scheduleAtSearch(det.query)
}

// @ 补全检索防抖：连续输入只在停顿 200ms 后发一次请求
let atSearchTimer: ReturnType<typeof setTimeout> | undefined
/**
 * 执行 schedule At Search
 * @param q - q
 */
function scheduleAtSearch(q: string) {
  clearTimeout(atSearchTimer)
  atSearchTimer = setTimeout(() => { void runAtSearch(q) }, 200)
}

/**
 * 运行 At Search
 * @param q - q
 */
async function runAtSearch(q: string) {
  const id = ++atReqId
  atLoading.value = true
  try {
    const pattern = q.trim() || '.'
    const res = await fetch('/__ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pattern, mode: 'file', max: 20 }),
    })
    const data = await res.json()
    if (id !== atReqId) return
    atResults.value = data.results || []
    atIndex.value = 0
  } catch {
    if (id === atReqId) atResults.value = []
  } finally {
    if (id === atReqId) atLoading.value = false
  }
}

/**
 * 响应 Editor Keydown
 * @param e - e
 */
function onEditorKeydown(e: KeyboardEvent) {
  if (!atVisible.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (atResults.value.length) atIndex.value = (atIndex.value + 1) % atResults.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (atResults.value.length) atIndex.value = (atIndex.value - 1 + atResults.value.length) % atResults.value.length
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const r = atResults.value[atIndex.value]
    if (r) pickAtResult(r.path)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    atVisible.value = false
  }
}

/**
 * 选取 At Result
 * @param p - p
 */
function pickAtResult(p: string) {
  removeAtText()
  atVisible.value = false
  addPaths([p])
}

/**
 * 移除 At Text
 */
function removeAtText() {
  if (atStartOffset < 0) return
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return
  const text = node.textContent || ''
  const offset = range.startOffset
  const newText = text.slice(0, atStartOffset) + text.slice(offset)
  node.textContent = newText
  const nr = document.createRange()
  nr.setStart(node, Math.min(atStartOffset, newText.length))
  nr.collapse(true)
  sel.removeAllRanges()
  sel.addRange(nr)
  syncQuestion()
  atStartOffset = -1
}

/**
 * 响应 Composition Start
 */
function onCompositionStart() { isComposing.value = true }
/**
 * 响应 Composition End
 */
function onCompositionEnd() { isComposing.value = false; onEditorInput() }

/** @ 弹出菜单的样式 */
const atPopoverStyle = computed(() => {
  if (!atRect.value) return {}
  return { top: `${atRect.value.top}px`, left: `${atRect.value.left}px` }
})

/**
 * 响应 Paste
 * @param e - e
 */
function onPaste(e: ClipboardEvent) {
  e.preventDefault()
  const text = e.clipboardData?.getData('text/plain')
  if (!text) return

  // 优先用 execCommand（保留 undo 栈）
  const ok = document.execCommand('insertText', false, text)
  if (!ok) {
    // Fallback: 手动操作 Selection API
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0)
      range.deleteContents()
      range.insertNode(document.createTextNode(text))
      // 将光标移到插入文本末尾
      range.setStartAfter(range.endContainer)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }
  // 手动同步（execCommand 在某些浏览器不触发 input 事件）
  syncQuestion()
}

/**
 * 执行 flash Success
 * @param count - count
 */
function flashSuccess(count: number) {
  success.value = true
  successCount.value = count
  setTimeout(() => { success.value = false }, 900)
}

/**
 * 添加 Paths
 * @param paths - paths
 * @param silent - silent
 */
async function addPaths(paths: string[], silent = false) {
  const toAdd = paths.filter(p => p && !files.value.some(f => f.path === p))
  if (!toAdd.length) return

  const entries: FileEntry[] = toAdd.map(p => ({ path: p, loading: true, justAdded: true }))
  entries.forEach(e => files.value.push(e))
  if (!silent) flashSuccess(entries.length)

  try {
    const res = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: toAdd }),
    })
    const data: FilesReadResponse = await res.json()
    const map = new Map<string, { path: string, content: string, error?: string }>()
    for (const f of data.files || []) map.set(f.path, f)

    entries.forEach((entry) => {
      const f = map.get(entry.path)
      if (f) {
        entry.content = f.content
        entry.error = f.error
      } else {
        entry.error = '读取失败'
      }
      entry.loading = false
    })
    // 强制触发 files 响应式更新
    files.value = [...files.value]
  } catch (err) {
    entries.forEach((e) => {
      e.error = String(err)
      e.loading = false
    })
  }
}

/**
 * 移除 File
 * @param p - p
 */
function removeFile(p: string) {
  files.value = files.value.filter(f => f.path !== p)
}

/**
 * 清空 All
 */
function clearAll() {
  files.value = []
}

/**
 * 判断是否为 Over Drop Zone
 * @param x - x
 * @param y - y
 */
function isOverDropZone(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return false
  return Boolean(el.closest('.pane-main'))
}

/**
 * 响应 Global Drag
 * @param e - e
 */
function onGlobalDrag(e: Event) {
  const d = (e as CustomEvent).detail as { primary: string, type: string, count: number, x: number, y: number }
  const inZone = isOverDropZone(d.x, d.y)
  dragging.value = inZone
  if (inZone) dragInfo.value = { count: d.count, type: d.type }
}

/**
 * 响应 Global Drop
 * @param e - e
 */
function onGlobalDrop(e: Event) {
  const d = (e as CustomEvent).detail as { paths: string[], primary: string, x: number, y: number }
  dragging.value = false
  dragInfo.value = null
  if (!isOverDropZone(d.x, d.y)) return
  addPaths(d.paths)
}

/**
 * 响应 Global Drag Cancel
 */
function onGlobalDragCancel() {
  dragging.value = false
  dragInfo.value = null
}

// HTML5 drag 兜底
/**
 * 响应 Html Drag Over
 * @param e - e
 */
function onHtmlDragOver(e: DragEvent) {
  e.preventDefault()
  dragging.value = true
}
/**
 * 响应 Html Drop
 * @param e - e
 */
function onHtmlDrop(e: DragEvent) {
  e.preventDefault()
  dragging.value = false
  dragInfo.value = null
  const p = e.dataTransfer?.getData('text/plain')
  if (p) addPaths([p])
}

/**
 * 运行 Search
 */
async function runSearch() {
  const p = searchQuery.value.trim()
  if (!p) return
  const id = ++searchReqId
  searching.value = true
  searchError.value = ''
  searchResults.value = []
  try {
    const res = await fetch('/__ai/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pattern: p,
        glob: searchGlob.value.trim() || undefined,
        mode: searchMode.value,
        lang: searchMode.value === 'ast' ? (searchLang.value.trim() || 'typescript') : undefined,
        max: 100,
      }),
    })
    const data = await res.json()
    if (id !== searchReqId) return
    if (data.error) { searchError.value = data.error; return }
    searchResults.value = data.results || []
  } catch (e) {
    if (id === searchReqId) searchError.value = String(e)
  } finally {
    if (id === searchReqId) searching.value = false
  }
}

/**
 * 添加 Search Result
 * @param path - path
 */
function addSearchResult(path: string) {
  addPaths([path])
}
/**
 * 添加 All Files
 */
async function addAllFiles() {
  if (addingAll.value) return
  addingAll.value = true
  try {
    const res = await fetch('/__ai/files/tree?path=')
    const data = await res.json()
    if (data.error) { toast(`加载失败：${data.error}`, 'error'); return }
    const paths: string[] = []
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        if (n.type === 'file') paths.push(n.path)
        else if (n.children?.length) walk(n.children)
      }
    }
    walk(data.tree || [])
    if (!paths.length) { toast('未找到可添加的文件', 'warn'); return }
    await addPaths(paths)
  } catch (e) {
    toast(`加载失败：${String(e)}`, 'error')
  } finally {
    addingAll.value = false
  }
}

/** 树文本 */
const treeText = ref('')
// [generate-panel-utils-extracted]
async function loadTree() {
  syncQuestion()
  try {
    const [res, pkgRes] = await Promise.all([
      fetch('/__ai/files?depth=2'),
      fetch('/__ai/files/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: ['package.json'] }),
      }),
    ])
    const pkgData = await pkgRes.json()
    const data = await res.json()
    let pkg: any = null
    const pkgFile = pkgData.files?.[0]
    if (pkgFile && !pkgFile.error) {
      try { pkg = JSON.parse(pkgFile.content) } catch { pkg = null }
    }
    treeText.value = formatRepoSummary(data.tree || [], pkg)
  } catch { /* ignore */ }
}

/** 提示词 */
const prompt = computed(() => {
  const sections: string[] = []
  const q = questionText.value
  if (q) sections.push(`# 问题：${q}`)
  const selectedSkillContents = skills.value.filter(s => selectedSkills.value.includes(s.name))
  if (selectedSkillContents.length) {
    sections.push(`# 规则\n\n${selectedSkillContents.map(s => s.content).join('\n\n---\n\n')}`)
  }
  if (treeText.value) sections.push(`# 项目结构\n\n${FENCE}\n${treeText.value}\n${FENCE}`)
  const valid = files.value.filter(f => !f.loading)
  if (valid.length) {
    sections.push('# 相关文件')
    sections.push(buildFullContext(
      valid.map(f => ({ path: f.path, content: f.content || '', error: f.error })),
      { stripComments: stripComments.value, stripBlankLines: stripBlankLines.value },
    ))
  }
  if (planMode.value) {
    sections.push([
      '# 输出要求：先计划，后代码',
      '',
      '请严格遵守两阶段输出：',
      '',
      '## 第一阶段：计划（不要给代码）',
      '1. 用 3-8 条要点描述你的方案（改哪些文件、核心思路、风险点）',
      '2. 明确说「如确认，回复继续」或「如需调整，指出哪一条」',
      '3. 不要在这一阶段输出任何完整代码块',
      '',
      '## 第二阶段：代码（仅在我回复「继续」后）',
      '1. 输出完整改动（可以是 patch 或整文件）',
      '2. 每处改动对应第一阶段的一条要点',
      '3. 不要回退无关代码',
    ].join('\n'))
  }
  return sections.join('\n\n')
})

/** 复制 */
const canCopy = computed(() => prompt.value.length > 0)

/* __ai_removed: deepseekUrl ref */
// URL 长度安全上限。超过就打开纯 URL，靠剪贴板兜底。
/* __ai_removed: DEEPSEEK_URL_MAX */

// 阈值轮转：发送后 + onMounted 都调用
/**
 * 校验 Rotate Session
 */
function checkRotateSession(): void {
  const r = rotateViaSM(summary => sendNewSession({ summary }))
  if (!r.fired) return
  if (r.sent) {
    toast(`已达 ${r.overCount} 次提问，已请求开启新对话`, 'info', 4000)
  } else {
    toast(`已达 ${r.overCount} 次提问，但 AI 窗口未就绪（请点右上角「打开 AI 窗口」）`, 'warn', 6000)
  }
}

/**
 * 复制 Prompt
 */
async function copyPrompt() {
  if (!canCopy.value) return
  // [skills-dynamic-load] 自动按任务匹配 skill，追加到 prompt
  let autoSkillsContent = ''
  let autoSkillKeys: string[] = []
  try {
    const q = questionText.value.trim()
    if (q) {
      const r = await fetch('/__ai/skills/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: q }),
      })
      if (r.ok) {
        const d = await r.json()
        autoSkillsContent = String(d?.content || '').trim()
        autoSkillKeys = Array.isArray(d?.keys) ? d.keys : []
      }
    }
  } catch { /* ignore */ }
  const basePrompt = prompt.value
  let mergedPrompt = basePrompt
  if (autoSkillsContent) {
    const skillNotice = autoSkillKeys.length
      ? `# 本轮自动加载的 skill\n${autoSkillKeys.map(k => `- ${k}`).join('\n')}\n\n请在回答开头用一句话说明你预计会用到哪些 skill（若都不相关，写「不需要额外 skill」）。\n\n`
      : ''
    mergedPrompt = `${basePrompt}\n\n# 规则（自动匹配）\n\n${skillNotice}${autoSkillsContent}`
  }
  const budget = enforceBudget(mergedPrompt)
  if (!budget.ok) {
    toast(`prompt 超出预算：${budget.size} / ${budget.budget} 字节`, 'error', 5000)
  }
  try {
    const text = mergedPrompt
    const r = await copyAndFill(text)
    if (r === 'failed') {
      toast('发送失败，已复制到剪贴板', 'warn', 4000)
      return
    }
    copied.value = true
    startAiWaiting()
    setTimeout(() => { copied.value = false }, 1500)
    {
      const q = questionText.value || '(无问题描述)'
      addTrace({
        kind: 'ask',
        summary: `问 AI · ${q.slice(0, 60)}${q.length > 60 ? '…' : ''}`,
        payload: {
          question: questionText.value,
          files: files.value.filter(f => !f.loading).map(f => f.path),
          prompt: text,
        },
      })
    }
    // [askcount-unify] 计数已下沉到 copyAndFill
    checkRotateSession()
    emit('sent')
  } catch { }
}

onMounted(() => {
  // 挂载补一次阈值检查
  checkRotateSession()
  window.addEventListener('keydown', onAddAllHotkey)

  window.addEventListener('ai-runner:drag', onGlobalDrag)
  window.addEventListener('ai-runner:drop', onGlobalDrop)
  window.addEventListener('ai-runner:drag-cancel', onGlobalDragCancel)
  const savedHtml = loadQuestion()
  if (savedHtml && editorRef.value) {
    editorRef.value.innerHTML = savedHtml
    syncQuestion()
  }
  const savedPaths = loadPaths()
  if (savedPaths.length) addPaths(savedPaths, true)
  loadTree()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onAddAllHotkey)

  window.removeEventListener('ai-runner:drag', onGlobalDrag)
  window.removeEventListener('ai-runner:drop', onGlobalDrop)
  window.removeEventListener('ai-runner:drag-cancel', onGlobalDragCancel)
})

/**
 * 响应 Add All Hotkey
 * @param e - e
 */
function onAddAllHotkey(e: KeyboardEvent) {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
  const k = String(e.key || '').toLowerCase()
  if (k !== 'a') return
  if (addingAll.value) return
  e.preventDefault()
  void addAllFiles()
}
</script>

<template>
  <div class="pane">
    <div
      class="pane-main"
      :class="{ 'is-dragging': dragging, 'is-success': success }"
      @dragover="onHtmlDragOver"
      @drop="onHtmlDrop"
    >
      <!-- 拖拽 / 成功浮层 -->
      <div v-if="dragging" class="drop-overlay">
        <div class="drop-card">
          <div class="drop-icon">
            📥
          </div>
          <div class="drop-text">
            松开以添加
            <template v-if="dragInfo && dragInfo.count > 1">
              {{ dragInfo.count }} 个文件
            </template>
            <template v-else>
              文件
            </template>
          </div>
        </div>
      </div>
      <div v-if="success" class="success-overlay">
        <div class="success-card">
          <div class="success-icon">
            ✓
          </div>
          <div class="success-text">
            已添加 {{ successCount }} 个文件
          </div>
        </div>
      </div>

      <!-- ========== 一体化智能输入区 ========== -->
      <div class="smart-editor card">
        <div class="editor-head">
          <h2>问题描述</h2>
          <div class="head-actions">
            <button v-tooltip="addingAll ? '正在加载文件树…' : '把项目所有文件加入「相关文件」'" class="btn btn-mini" :disabled="addingAll" @click="addAllFiles">
              <svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
              <span>{{ addingAll ? "加载中…" : "添加全部" }}</span>
            </button>
            <button v-tooltip="files.length ? `移除全部 ${files.length} 个已附加文件` : '当前没有可清空的文件'" class="btn btn-mini btn-ghost-danger" :disabled="!files.length" @click="clearAll">
              <svg class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
              </svg>
              <span>清空</span>
            </button>
            <button
              v-tooltip="aiWaiting ? '等待 AI 回复…' : copied ? '已发送' : '把问题 + 规则 + 项目结构 + 相关文件拼成 prompt 复制并发给 DeepSeek'"
              class="btn btn-cta btn-primary"
              :class="{ loading: aiWaiting }"
              :disabled="!canCopy || aiWaiting"
              @click="copyPrompt"
            >
              <svg v-if="aiWaiting" class="btn-ico spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <svg v-else-if="!copied" class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
              <svg v-else class="btn-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              <span>{{ aiWaiting ? '等待回复…' : copied ? '已发送' : '发送给 AI' }}</span>
            </button>
          </div>
        </div>

        <!-- 文件 Tags 区域 -->
        <div v-if="files.length" class="tags-area">
          <TransitionGroup name="tag">
            <div
              v-for="f in files"
              :key="f.path"
              v-tooltip="f.error || f.path"
              class="file-tag"
              :class="{ err: f.error, loading: f.loading }"
            >
              <span class="tag-icon">{{ f.loading ? '⏳' : f.error ? '⚠' : '📄' }}</span>
              <span class="tag-name">{{ f.path.split('/').pop() }}</span>
              <span class="tag-dir">{{ f.path.substring(0, f.path.lastIndexOf('/') + 1) }}</span>
              <button v-tooltip="`移除 ${f.path}`" class="tag-remove" @click.stop="removeFile(f.path)">
                ×
              </button>
            </div>
          </TransitionGroup>
        </div>

        <!-- ContentEditable 输入区 -->
        <div
          ref="editorRef"
          class="editor-content"
          contenteditable="true"
          spellcheck="false"
          data-placeholder="描述你想问 AI 的问题… 支持 @ 呼出检索，或拖入文件 · ⌘/Ctrl + ↵ 发送"
          @input="onEditorInput"
          @keydown.exact="onEditorKeydown"
          @keydown.meta.enter.prevent="copyPrompt"
          @keydown.ctrl.enter.prevent="copyPrompt"
          @compositionstart="onCompositionStart"
          @compositionend="onCompositionEnd"
          @paste.prevent="onPaste"
        />

        <!-- @ 提及弹窗 -->
        <Teleport to="body">
          <div
            v-if="atVisible"
            class="at-popover"
            :style="atPopoverStyle"
            @mousedown.prevent
          >
            <div class="at-header">
              <span class="at-sigil">@</span>
              <span class="at-q">{{ atQuery || '全部文件' }}</span>
              <span v-if="atLoading" class="at-spinner" />
            </div>
            <div v-if="atResults.length" class="at-list">
              <div
                v-for="(r, i) in atResults"
                :key="r.path"
                class="at-item"
                :class="{ active: i === atIndex }"
                @mouseenter="atIndex = i"
                @mousedown.prevent="pickAtResult(r.path)"
              >
                {{ r.path }}
              </div>
            </div>
            <div v-else-if="!atLoading" class="at-empty">
              无匹配文件
            </div>
            <div class="at-footer">
              <kbd>↑</kbd><kbd>↓</kbd> 选择 · <kbd>↵</kbd> 确认 · <kbd>Esc</kbd> 取消
            </div>
          </div>
        </Teleport>

        <!-- 底部工具栏：检索入口 -->
        <!-- Skills 折叠区 -->
        <div v-if="showSkills" class="skills-panel">
          <div class="skills-header">
            <span class="skills-title">Skills（{{ selectedSkills.length }} / {{ skills.length }} 启用）</span>
            <button v-tooltip="'选中全部 Skill'" class="skills-bulk" :disabled="!skills.length || selectedSkills.length === skills.length" @click="selectAllSkills">
              全选
            </button>
            <button v-tooltip="'清空已选'" class="skills-bulk" :disabled="!selectedSkills.length" @click="clearAllSkills">
              清空
            </button>
            <button v-tooltip="'收起'" aria-label="收起" class="skills-close" @click="showSkills = false">
              ×
            </button>
          </div>
          <div v-if="skills.length" class="skills-list">
            <label v-for="s in skills" :key="s.name" class="skill-item">
              <input type="checkbox" :checked="selectedSkills.includes(s.name)" @change="toggleSkill(s.name)">
              <span class="skill-name">{{ s.name }}</span>
              <span v-if="s.source === 'base'" v-tooltip="'随代码分发，不可删除'" class="skill-source-tag">基础</span>
              <button v-if="s.source === 'user'" v-tooltip="`删除用户 Skill「${s.name}」`" class="skill-delete" @click.prevent.stop="deleteSkill(s.name)">×</button>
            </label>
          </div>
          <div v-else class="skills-empty">
            还没有 Skill。可在下方新建，或把 .md 放到 <code>.ai-runner/skills/</code> 目录
          </div>
          <details class="skill-new">
            <summary>+ 新建 Skill</summary>
            <input v-model="newSkillName" class="skill-input" placeholder="名字（字母数字短横，如 i-have-adhd）" spellcheck="false">
            <textarea v-model="newSkillContent" class="skill-textarea" rows="5" placeholder="内容：一段提示词 / 行为指令..." />
            <button
              v-tooltip="creatingSkill ? '保存中…' : '保存新 Skill 到 .ai-runner/skills/'"
              class="skill-save"
              :disabled="!newSkillName.trim() || !newSkillContent.trim() || creatingSkill"
              @click="createSkill"
            >
              {{ creatingSkill ? '保存中…' : '保存' }}
            </button>
          </details>
        </div>

        <div class="editor-footer">
          <button v-tooltip="showSkills ? '收起 Skills 面板' : '展开 Skills 面板（提示词 / 行为规则）'" class="search-trigger" :class="{ active: showSkills }" @click="showSkills = !showSkills">
            <span>Skills</span>
            <span v-if="selectedSkills.length" class="skill-badge">{{ selectedSkills.length }}</span>
          </button>
          <button v-tooltip="showSearch ? '收起全局检索' : '展开全局检索（正则 / 关键字 + glob 过滤）'" class="search-trigger" :class="{ active: showSearch }" @click="showSearch = !showSearch">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
            <span>{{ showSearch ? '收起检索' : '全局检索' }}</span>
          </button>
          <label
            v-tooltip="'先输出计划，我确认后再输出代码'"
            class="plan-toggle"
            :class="{ active: planMode }"
          >
            <input v-model="planMode" type="checkbox">
            <span>计划模式</span>
          </label>
          <span v-if="files.length" class="file-count">{{ files.length }} 个文件已附加</span>
        </div>
      </div>

      <!-- ========== 内联检索面板 ========== -->
      <Transition name="slide">
        <div v-if="showSearch" class="search-panel card">
          <div class="search-bar">
            <input
              v-model="searchQuery"
              class="search-input"
              spellcheck="false"
              placeholder="正则 / 关键字（如 useRunner|createBlock）"
              @keydown.enter="runSearch"
            >
            <input
              v-model="searchGlob"
              class="search-glob"
              spellcheck="false"
              placeholder="glob（如 src/**/*.ts）"
              @keydown.enter="runSearch"
            >
            <select v-model="searchMode" class="search-mode">
              <option value="content">
                文本
              </option>
              <option value="file">
                文件名
              </option>
              <option value="ast">
                AST
              </option>
            </select>
            <input
              v-if="searchMode === 'ast'"
              v-model="searchLang"
              class="search-lang"
              spellcheck="false"
              placeholder="typescript / javascript / vue"
            >
            <button v-tooltip="searching ? '正在搜索…' : '按关键字 / 正则搜索（Enter）'" class="btn btn-mini btn-primary" :disabled="searching || !searchQuery.trim()" @click="runSearch">
              {{ searching ? '搜索中…' : '搜索' }}
            </button>
          </div>
          <div v-if="searchError" class="search-error">
            {{ searchError }}
          </div>
          <div v-else-if="searchResults.length" class="search-results">
            <div
              v-for="(r, i) in searchResults"
              :key="`${r.path}-${r.line ?? 0}-${i}`"
              class="search-row"
            >
              <button v-tooltip="'添加到相关文件'" aria-label="添加到相关文件" class="search-add" @click="addSearchResult(r.path)">
                +
              </button>
              <span class="search-path">{{ r.path }}</span>
              <span v-if="r.line" class="search-line">:{{ r.line }}</span>
              <span v-if="r.text" class="search-text">{{ r.text }}</span>
            </div>
          </div>
          <div v-else-if="!searching" class="search-empty">
            输入关键字后回车搜索
          </div>
        </div>
      </Transition>
    </div>

    <!-- 右侧：文件树 -->
    <aside class="pane-side">
      <FileTree root draggable />
    </aside>
  </div>
</template>

<style scoped lang="scss" src="./GeneratePanel.scss">
</style>
<!-- tooltip-audit -->
