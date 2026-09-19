<script setup lang="ts">
defineOptions({ name: 'GeneratePanel' })
const emit = defineEmits<{ sent: [] }>()
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import FileTree from './FileTree.vue'
import { copyAndFill } from '../composables/useDeepseekUrl'
import { useAiWaiting } from '../composables/useAiWaiting'
import { useCodeCleaner } from '../composables/useCodeCleaner'
import { buildFullContext, enforceBudget } from '../utils/contextBuilder'
import { useToast } from '../composables/useToast'
import { useTraceLog } from '../composables/useTraceLog'
import { useSessionManager } from '../composables/useSessionManager'
import type { FilesReadResponse } from '../types'

interface FileEntry {
  path: string
  content?: string
  error?: string
  loading?: boolean
  justAdded?: boolean
}

const FENCE = '```'

// ---------- 状态 ----------
const editorRef = ref<HTMLDivElement>()
const files = ref<FileEntry[]>([])
const dragging = ref(false)
const dragInfo = ref<{ count: number, type: string } | null>(null)
const success = ref(false)
const successCount = ref(0)
const copied = ref(false)
const mainRef = ref<HTMLElement>()

const { waiting: aiWaiting, startWaiting: startAiWaiting } = useAiWaiting()

// 检索相关
const searchQuery = ref('')
const searchGlob = ref('')
const searchMode = ref<'content' | 'file' | 'ast'>('content')
const searchLang = ref('typescript')
const searching = ref(false)
const searchResults = ref<Array<{ path: string, line?: number, text?: string }>>([])
const searchError = ref('')
const showSearch = ref(false)
const addingAll = ref(false)
const KEY_PLAN = '__ai_plan_mode'
function loadPlanMode(): boolean {
  try { return localStorage.getItem(KEY_PLAN) === '1' } catch { return false }
}
const planMode = ref(loadPlanMode())
watch(planMode, (v) => {
  try { localStorage.setItem(KEY_PLAN, v ? '1' : '0') } catch { }
})
let searchReqId = 0

// 代码清洗（开关从全局 composable 读）
const { stripComments, stripBlankLines } = useCodeCleaner()
const { toast } = useToast()
const { addTrace } = useTraceLog()
const { trackMessage } = useSessionManager()
const questionText = ref('')

// Skills
interface Skill { name: string, content: string, source?: 'base' | 'user' }
const skills = ref<Skill[]>([])
const selectedSkills = ref<string[]>(loadSelectedSkills())
const showSkills = ref(false)
const newSkillName = ref('')
const newSkillContent = ref('')
const creatingSkill = ref(false)

function loadSelectedSkills(): string[] {
  try {
    const raw = localStorage.getItem('__ai_selected_skills')
    if (raw === null) return ['gen-script-rules']
    return JSON.parse(raw)
  } catch { return ['gen-script-rules'] }
}

watch(selectedSkills, (v) => {
  try { localStorage.setItem('__ai_selected_skills', JSON.stringify(v)) } catch { /* ignore */ }
}, { deep: true })

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

async function deleteSkill(name: string) {
  await fetch(`/__ai/skills?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
  selectedSkills.value = selectedSkills.value.filter(s => s !== name)
  await loadSkills()
}

function toggleSkill(name: string) {
  const i = selectedSkills.value.indexOf(name)
  if (i >= 0) selectedSkills.value.splice(i, 1)
  else selectedSkills.value.push(name)
}

// 立即加载（不依赖 onMounted，避开不同版本差异）
loadSkills()

// @ 提及
const atVisible = ref(false)
const atQuery = ref('')
const atResults = ref<Array<{ path: string }>>([])
const atRect = ref<{ top: number, left: number } | null>(null)
const atIndex = ref(0)
const atLoading = ref(false)
const isComposing = ref(false)
let atStartOffset = -1
let atReqId = 0

// ---------- 编辑器辅助 ----------
function syncQuestion() {
  questionText.value = editorRef.value?.innerText?.trim() || ''
}
const KEY_QUESTION = '__ai_generate_question'
const KEY_PATHS = '__ai_generate_paths'
let saveQuestionTimer: ReturnType<typeof setTimeout> | null = null
function saveQuestionNow() {
  if (!editorRef.value) return
  try {
    const html = editorRef.value.innerHTML
    if (html) localStorage.setItem(KEY_QUESTION, html)
    else localStorage.removeItem(KEY_QUESTION)
  } catch { }
}
function saveQuestion() {
  if (saveQuestionTimer) clearTimeout(saveQuestionTimer)
  saveQuestionTimer = setTimeout(saveQuestionNow, 300)
}
function loadQuestion(): string {
  try { return localStorage.getItem(KEY_QUESTION) || '' } catch { return '' }
}
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
function scheduleAtSearch(q: string) {
  clearTimeout(atSearchTimer)
  atSearchTimer = setTimeout(() => { void runAtSearch(q) }, 200)
}

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

function pickAtResult(p: string) {
  removeAtText()
  atVisible.value = false
  addPaths([p])
}

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

function onCompositionStart() { isComposing.value = true }
function onCompositionEnd() { isComposing.value = false; onEditorInput() }

const atPopoverStyle = computed(() => {
  if (!atRect.value) return {}
  return { top: `${atRect.value.top}px`, left: `${atRect.value.left}px` }
})

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

function focusEditor() {
  nextTick(() => {
    editorRef.value?.focus()
    // 将光标移到末尾
    const sel = window.getSelection()
    if (sel && editorRef.value) {
      sel.selectAllChildren(editorRef.value)
      sel.collapseToEnd()
    }
  })
}

// ---------- 文件管理 ----------
function flashSuccess(count: number) {
  success.value = true
  successCount.value = count
  setTimeout(() => { success.value = false }, 900)
}

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

function removeFile(p: string) {
  files.value = files.value.filter(f => f.path !== p)
}

function clearAll() {
  files.value = []
}

// ---------- 拖拽处理 ----------
function isOverDropZone(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  if (!el) return false
  return Boolean(el.closest('.pane-main'))
}

function onGlobalDrag(e: Event) {
  const d = (e as CustomEvent).detail as { primary: string, type: string, count: number, x: number, y: number }
  const inZone = isOverDropZone(d.x, d.y)
  dragging.value = inZone
  if (inZone) dragInfo.value = { count: d.count, type: d.type }
}

function onGlobalDrop(e: Event) {
  const d = (e as CustomEvent).detail as { paths: string[], primary: string, x: number, y: number }
  dragging.value = false
  dragInfo.value = null
  if (!isOverDropZone(d.x, d.y)) return
  addPaths(d.paths)
}

function onGlobalDragCancel() {
  dragging.value = false
  dragInfo.value = null
}

// HTML5 drag 兜底
function onHtmlDragOver(e: DragEvent) {
  e.preventDefault()
  dragging.value = true
}
function onHtmlDrop(e: DragEvent) {
  e.preventDefault()
  dragging.value = false
  dragInfo.value = null
  const p = e.dataTransfer?.getData('text/plain')
  if (p) addPaths([p])
}

// ---------- 检索 ----------
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

function addSearchResult(path: string) {
  addPaths([path])
}
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

// ---------- Prompt 生成 ----------
const treeText = ref('')
function formatRepoSummary(tree: any[], pkg: any): string {
  const lines: string[] = []
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
    const wanted = [
      'vue',
      'vue-router',
      'pinia',
      'element-plus',
      'unocss',
      'vite',
      'typescript',
      'axios',
      'echarts',
      'maplibre-gl',
      'vitest',
      '@playwright/test',
    ]
    const stack: string[] = []
    for (const name of wanted) {
      if (!deps[name]) continue
      const raw = String(deps[name])
      const clean = raw.replace(/^[~^]/, '')
      stack.push(`${name}@${clean}`)
    }
    if (stack.length) lines.push(`技术栈：${stack.join(' / ')}`)
    if (pkg.scripts) {
      const names = Object.keys(pkg.scripts).filter((k: string) => k === 'dev' || k === 'build' || k.startsWith('test'))
      if (names.length) lines.push(`脚本：${names.join(' / ')}`)
    }
  }
  const DIR_HINTS: Record<string, string> = {
    src: '主应用源码（Vue 3 + Element Plus）',
    plugins: 'AI Runner（Vite 插件 + 前端 SPA）',
    public: '静态资源',
    types: '全局类型声明',
    dist: '构建产物',
    e2e: 'e2e 测试',
  }
  const dirs = tree.filter((n: any) => n.type === 'directory').map((n: any) => n.name)
  if (dirs.length) {
    lines.push('顶层目录：')
    for (const d of dirs) {
      const hint = DIR_HINTS[d] || ''
      lines.push(`  ${d}/${hint ? `  ${hint}` : ''}`)
    }
  }
  const keyFiles = ['package.json', 'vite.config.ts', 'tsconfig.json', 'README.md', 'AGENTS.md']
  const present = tree.filter((n: any) => n.type === 'file' && keyFiles.includes(n.name)).map((n: any) => n.name)
  if (present.length) lines.push(`关键文件：${present.join(' / ')}`)
  return lines.join('\n')
}
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

const canCopy = computed(() => prompt.value.length > 0)

/* __ai_removed: deepseekUrl ref */
// URL 长度安全上限。超过就打开纯 URL，靠剪贴板兜底。
/* __ai_removed: DEEPSEEK_URL_MAX */

async function copyPrompt() {
  if (!canCopy.value) return
  const budget = enforceBudget(prompt.value)
  if (!budget.ok) {
    toast(`prompt 超出预算：${budget.size} / ${budget.budget} 字节`, 'error', 5000)
  }
  try {
    const text = prompt.value
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
    trackMessage('user', text)
    emit('sent')
  } catch {  }
}

// ---------- 生命周期 ----------
onMounted(() => {
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
  window.removeEventListener('ai-runner:drag', onGlobalDrag)
  window.removeEventListener('ai-runner:drop', onGlobalDrop)
  window.removeEventListener('ai-runner:drag-cancel', onGlobalDragCancel)
})
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
              class="btn btn-primary btn-cta"
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
          @keydown="onEditorKeydown"
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
            <button v-tooltip="'收起'" class="skills-close" @click="showSkills = false">
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
              <option value="content">文本</option>
              <option value="file">文件名</option>
              <option value="ast">AST</option>
            </select>
            <input
              v-if="searchMode === 'ast'"
              v-model="searchLang"
              class="search-lang"
              spellcheck="false"
              placeholder="typescript / javascript / vue"
            >
            <button v-tooltip="searching ? '正在搜索…' : '按关键字 / 正则搜索（Enter）'" class="btn btn-primary btn-mini" :disabled="searching || !searchQuery.trim()" @click="runSearch">
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
              <button v-tooltip="'添加到相关文件'" class="search-add" @click="addSearchResult(r.path)">
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

<style scoped lang="scss">
.pane {
  display: flex;
  /* tighten-spacing */
  gap: 10px;
  align-items: stretch;
  position: relative;
  height: 100%;
  min-height: 0;
}
.pane-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  /* tighten-spacing */
  gap: 8px;
  position: relative;
  border-radius: var(--radius);
  transition: box-shadow 0.15s;
  min-height: 0;
  overflow: hidden;
}
.pane-main.is-dragging {
  box-shadow: 0 0 0 3px rgb(37 99 235 / 25%);
}
.pane-main.is-success {
  box-shadow: 0 0 0 3px rgb(16 185 129 / 35%);
}
.pane-side {
  /* tighten-spacing */
  width: 232px;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* Card */
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  overflow: hidden;
}

/* ========== Smart Editor ========== */
.smart-editor {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.editor-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  /* tighten-spacing */
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.editor-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}
.head-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* Tags Area */
.tags-area {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  /* tighten-spacing */
  padding: 7px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  min-height: 42px;
  max-height: 140px;
  overflow-y: auto;
  align-items: flex-start;
  align-content: flex-start;
}
.file-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px 3px 6px;
  border-radius: 6px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 11px;
  font-family: var(--mono);
  max-width: 280px;
  animation: tag-in 0.25s ease-out;
}
.file-tag.err {
  background: var(--danger-bg);
  color: var(--danger);
}
.file-tag.loading {
  opacity: 0.7;
}
.tag-icon {
  font-size: 11px;
  flex-shrink: 0;
}
.tag-name {
  font-weight: 600;
  white-space: nowrap;
}
.tag-dir {
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}
.tag-remove {
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0.6;
  transition: 0.12s;
  flex-shrink: 0;
}
.tags-area::-webkit-scrollbar {
  width: 6px;
}
.tags-area::-webkit-scrollbar-thumb {
  background: var(--border-2);
  border-radius: 3px;
}
.tags-area::-webkit-scrollbar-thumb:hover {
  background: var(--text-3);
}
.tag-remove:hover {
  opacity: 1;
  background: var(--primary-bg);
}
.file-tag.err .tag-remove:hover {
  background: var(--danger-bg);
}

@keyframes tag-in {
  from {
    opacity: 0;
    transform: scale(0.85) translateY(-4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
.tag-enter-active {
  animation: tag-in 0.25s ease-out;
}
.tag-leave-active {
  animation: tag-in 0.15s ease-in reverse;
}

/* ContentEditable */
.editor-content {
  flex: 1;
  min-height: 80px;
  /* tighten-spacing */
  padding: 10px 12px;
  font:
    13px/1.7 -apple-system,
    BlinkMacSystemFont,
    'Segoe UI',
    'PingFang SC',
    sans-serif;
  color: var(--text);
  outline: 0;
  white-space: pre-wrap;
  word-break: break-word;
  cursor: text;

  overflow-y: auto;
}
.editor-content:empty::before {
  content: attr(data-placeholder);
  color: var(--text-3);
  pointer-events: none;
}
.editor-content:focus {
  background: var(--surface);
}

/* ============ @ 提及弹窗 ============ */
.at-popover {
  position: fixed;
  z-index: 1000;
  min-width: 280px;
  max-width: 480px;
  background: var(--surface);
  border: 1px solid var(--border, #e5e9f0);
  border-radius: 8px;
  box-shadow: 0 8px 28px rgb(15 30 60 / 16%);
  overflow: hidden;
  font-size: 12px;
}
.at-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border, #e5e9f0);
  color: var(--text-3, #8592a6);
}
.at-sigil {
  color: var(--primary, #2563eb);
  font-weight: 700;
}
.at-q {
  color: var(--text, #1f2d3d);
  font-family: var(--mono, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.at-spinner {
  margin-left: auto;
  width: 10px;
  height: 10px;
  border: 2px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: at-spin 0.7s linear infinite;
}
@keyframes at-spin {
  to {
    transform: rotate(360deg);
  }
}
.at-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 4px 0;
}
.at-item {
  padding: 5px 12px;
  cursor: pointer;
  font-family: var(--mono, monospace);
  color: var(--text, #1f2d3d);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.at-item.active {
  background: var(--primary-bg);
  color: var(--primary);
}
.at-item:hover {
  background: var(--surface-2);
}
.at-empty {
  padding: 16px 12px;
  text-align: center;
  color: var(--text-3, #8592a6);
  font-style: italic;
}
.at-footer {
  padding: 5px 12px;
  border-top: 1px solid var(--border, #e5e9f0);
  background: var(--surface-2);
  color: var(--text-3, #8592a6);
  font-size: 10px;
  display: flex;
  gap: 4px;
  align-items: center;
}
.at-footer kbd {
  display: inline-block;
  padding: 1px 5px;
  background: var(--surface);
  border: 1px solid var(--border-2, #d0d7de);
  border-bottom-width: 2px;
  border-radius: 3px;
  font: 10px/1 var(--mono, monospace);
  color: var(--text-2, #56667c);
}

/* Footer */
.editor-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  /* tighten-spacing */
  padding: 6px 12px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  flex-shrink: 0;
}
.search-trigger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  transition: 0.15s;
}
.search-trigger:hover {
  background: var(--surface-2);
  color: var(--text);
}
.search-trigger.active {
  background: var(--primary-bg);
  color: var(--primary);
  border-color: var(--primary);
}
.plan-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
  transition: 0.15s;
}
.plan-toggle:hover {
  background: var(--surface-2);
  color: var(--text);
}
.plan-toggle.active {
  background: var(--primary-bg);
  color: var(--primary);
  border-color: var(--primary);
}
.plan-toggle input {
  margin: 0;
  accent-color: var(--primary);
}
.file-count {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
}

/* ========== Search Panel ========== */
.search-panel {
  display: flex;
  flex-direction: column;
}
.search-bar {
  display: flex;
  gap: 8px;
  /* tighten-spacing */
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.search-input,
.search-glob {
  min-width: 0;
  padding: 6px 10px;
  font: 12px/1.5 var(--mono);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  outline: 0;
}

.search-mode {
  flex: 0 0 96px;
  padding: 6px 8px;
  font: 12px/1.5 var(--mono);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  outline: 0;
  cursor: pointer;
}
.search-lang {
  flex: 0 0 140px;
  padding: 6px 10px;
  font: 12px/1.5 var(--mono);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-sm);
  outline: 0;
}
.search-lang:focus,
.search-mode:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-bg);
}
.search-input {
  flex: 1;
}
.search-glob {
  flex: 0 0 180px;
}
.search-input:focus,
.search-glob:focus {
  border-color: var(--primary);
  box-shadow: 0 0 0 2px var(--primary-bg);
}
.search-error {
  padding: 10px 16px;
  color: var(--danger);
  font-size: 12px;
}
.search-results {
  max-height: 260px;
  overflow-y: auto;
  padding: 4px 0;
}
.search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px;
  font: 12px/1.5 var(--mono);
  transition: background 0.1s;
}
.search-row:hover {
  background: var(--surface-2);
}
.search-add {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 4px;
  background: var(--primary-bg);
  color: var(--primary);
  font-size: 13px;
  font-weight: 700;
  cursor: pointer;
}
.search-add:hover {
  background: var(--primary);
  color: #fff;
}
.search-path {
  color: var(--text-2);
}
.search-line {
  color: var(--primary);
  font-weight: 600;
}
.search-text {
  flex: 1;
  min-width: 0;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.search-empty {
  padding: 20px 16px;
  text-align: center;
  color: var(--text-3);
  font-size: 12px;
  font-style: italic;
}

/* Slide transition */
/* ========== Skills ========== */
.skills-panel {
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
}
.skills-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}
.skills-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.skills-close {
  width: 20px;
  height: 20px;
  border: 0;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
}
.skills-close:hover {
  color: var(--danger);
}
.skills-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.skill-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  font-size: 12px;
  cursor: pointer;
  user-select: none;
}
.skill-item:hover {
  background: var(--surface-2);
}
.skill-item input {
  margin: 0;
}
.skill-name {
  font-family: var(--mono);
  color: var(--text);
}
.skill-source-tag {
  padding: 0 5px;
  margin-left: 2px;
  background: var(--primary-bg);
  color: var(--primary);
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.3px;
  text-transform: uppercase;
}
.skill-delete {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  opacity: 0;
  transition: 0.12s;
}
.skill-item:hover .skill-delete {
  opacity: 0.6;
}
.skill-delete:hover {
  opacity: 1 !important;
  color: var(--danger);
  background: var(--danger-bg);
}
.skills-empty {
  padding: 8px 0;
  font-size: 11px;
  color: var(--text-3);
  font-style: italic;
}
.skills-empty code {
  padding: 1px 4px;
  background: var(--surface-2);
  border-radius: 3px;
  font-family: var(--mono);
  font-style: normal;
}
.skill-new {
  margin-top: 4px;
  font-size: 12px;
}
.skill-new summary {
  cursor: pointer;
  color: var(--primary);
  user-select: none;
}
.skill-input,
.skill-textarea {
  display: block;
  width: 100%;
  margin-top: 6px;
  padding: 6px 8px;
  font-family: var(--mono);
  font-size: 12px;
  border: 1px solid var(--border-2);
  border-radius: 6px;
  background: var(--surface);
  outline: 0;
  box-sizing: border-box;
}
.skill-input:focus,
.skill-textarea:focus {
  border-color: var(--primary);
}
.skill-textarea {
  resize: vertical;
}
.skill-save {
  margin-top: 6px;
  padding: 4px 12px;
  border: 0;
  border-radius: 5px;
  background: var(--primary);
  color: #fff;
  font-size: 12px;
  cursor: pointer;
}
.skill-save:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.skill-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  margin-left: 4px;
  background: var(--primary);
  color: #fff;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
}

.slide-enter-active {
  transition: all 0.2s ease-out;
}
.slide-leave-active {
  transition: all 0.15s ease-in;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* ========== Overlays ========== */
.drop-overlay,
.success-overlay {
  position: absolute;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  border-radius: var(--radius);
}
.drop-overlay {
  background: rgb(37 99 235 / 8%);
}
.success-overlay {
  background: rgb(16 185 129 / 10%);
  z-index: 11;
  animation: fade-in 0.15s ease-out;
}
.drop-card,
.success-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 20px 28px;
  background: var(--surface);
  border-radius: var(--radius);
  box-shadow: 0 4px 20px rgb(37 99 235 / 20%);
  animation: pop-in 0.18s ease-out;
}
.drop-card {
  border: 2px dashed var(--primary);
  background: var(--surface);
}
.success-card {
  border: 2px solid var(--success);
  background: var(--surface);
  box-shadow: 0 4px 20px rgb(16 185 129 / 25%);
  animation: pop-in 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.drop-icon {
  font-size: 28px;
}
.drop-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--primary);
}
.success-icon {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--success-bg);
  color: var(--success);
  font-size: 20px;
  font-weight: 700;
}
.success-text {
  font-size: 13px;
  font-weight: 600;
  color: var(--success);
}
@keyframes pop-in {
  from {
    transform: scale(0.9);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* Buttons */
.btn {
  padding: 7px 16px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border-2);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: all 0.18s ease;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  box-shadow: 0 1px 2px rgb(15 30 60 / 4%);
}
.btn:hover:not(:disabled) {
  background: var(--surface-2);
  border-color: var(--primary);
  color: var(--primary);
  transform: translateY(-1px);
  box-shadow: 0 3px 8px rgb(37 99 235 / 12%);
}
.btn:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgb(15 30 60 / 4%);
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.btn-primary {
  background: var(--primary);
  color: #fff;
  border-color: transparent;
  box-shadow: 0 2px 6px rgb(37 99 235 / 28%);
}
.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover);
  color: #fff;
  box-shadow: 0 6px 16px rgb(37 99 235 / 32%);
  transform: translateY(-1px);
}
.btn-primary:active:not(:disabled) {
  transform: translateY(0);
  box-shadow: 0 2px 6px rgb(37 99 235 / 28%);
}
.btn-mini {
  padding: 4px 12px;
  font-size: 12px;
}
.btn-ico {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.btn-ghost-danger:hover:not(:disabled) {
  border-color: var(--danger);
  color: var(--danger);
  background: rgb(239 68 68 / 6%);
}
.btn-cta {
  padding: 5px 12px;
  font-size: 12px;
}
.btn-cta .btn-ico {
  width: 13px;
  height: 13px;
}
.btn-cta.loading {
  cursor: progress;
}
.btn-ico.spin {
  animation: at-spin 0.9s linear infinite;
}

.strip-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
}
.strip-toggle input {
  margin: 0;
}

@media (max-width: 1100px) {
  .pane {
    flex-direction: column;
  }
  .pane-side {
    width: 100%;
    max-height: 46vh;
    position: static;
  }
}
@media (max-width: 720px) {
  .editor-head {
    padding: 8px 10px;
  }
  .editor-footer {
    padding: 6px 10px;
    gap: 8px;
    flex-wrap: wrap;
  }
  .search-bar {
    flex-wrap: wrap;
  }
  .search-glob {
    flex: 0 0 100%;
  }
  .tags-area {
    padding: 8px 10px;
  }
  .file-tag {
    max-width: 100%;
  }
}

/* ═══════════════════════════════════════════════════════════
   [button-theme] 按钮配色重做：暖橙强调 + 灰阶次按钮
   参考 Claude Code / Codex 克制配色
   ═══════════════════════════════════════════════════════════ */

/* ——— 次按钮：透明底 + 细边框，hover 时淡淡提亮 ——— */
.ghost-btn {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  padding: 4px 10px !important;
  font-size: var(--font-12) !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 8%) !important;
}
.ghost-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }

/* ——— 终端内按钮 ——— */
.term-btn {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.term-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.term-btn:disabled { opacity: 0.4 !important; cursor: not-allowed !important; }
.term-btn.copy, .term-btn.ask-panel { color: var(--text-2) !important; border-color: rgb(255 255 255 / 8%) !important; }
.term-btn.copy:hover:not(:disabled), .term-btn.ask-panel:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important; color: var(--text) !important; border-color: rgb(255 255 255 / 14%) !important;
}

/* ——— 芯片 / 下拉 / tab ——— */
.tpl-chip {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
}
.tpl-chip:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.draft-select {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
}
.draft-select:hover { border-color: rgb(255 255 255 / 14%) !important; }

/* ——— primary 系列（运行/主操作）：暖橙实底 ——— */
.primary-btn.run {
  background: var(--primary) !important;
  color: #fff !important;
  box-shadow: none !important;
  border: 0 !important;
}
.primary-btn.run:hover:not(:disabled) { background: var(--primary-hover) !important; box-shadow: none !important; }

/* 运行按钮（takeover 态）：暖橙描边，非实心，更克制 */
.primary-btn.takeover {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(217 119 87 / 12%) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
}

/* 停止 / 暂停：柔和红描边 */
.primary-btn.stop {
  background: transparent !important;
  color: var(--danger) !important;
  border: 1px solid var(--danger) !important;
  box-shadow: none !important;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  color: #fff !important;
  border-color: var(--danger) !important;
}

/* ——— loop-btn 系列 ——— */
.loop-btn {
  background: transparent !important;
  border: 1px solid rgb(255 255 255 / 8%) !important;
  color: var(--text-2) !important;
  border-radius: 6px !important;
  box-shadow: none !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.loop-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 14%) !important;
}
.loop-btn:active:not(:disabled) { box-shadow: none !important; }
.loop-btn:focus-visible { outline: 0 !important; box-shadow: 0 0 0 2px rgb(217 119 87 / 30%) !important; }
.loop-btn:disabled { opacity: 0.4 !important; background: transparent !important; color: var(--text-3) !important; }

.loop-btn.primary {
  background: var(--primary) !important;
  border-color: var(--primary) !important;
  color: #fff !important;
  box-shadow: none !important;
}
.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  color: #fff !important;
  box-shadow: none !important;
}
.loop-btn.kill, .loop-btn.rollback {
  background: transparent !important;
  border-color: rgb(224 108 117 / 55%) !important;
  color: var(--danger) !important;
  box-shadow: none !important;
}
.loop-btn.kill:hover:not(:disabled), .loop-btn.rollback:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  border-color: var(--danger) !important;
  color: #fff !important;
  box-shadow: none !important;
}

/* ——— 决策按钮 ——— */
.decision-btn {
  background: rgb(217 119 87 / 12%) !important;
  color: var(--primary) !important;
  border-color: var(--primary) !important;
  font-weight: 600 !important;
}
.decision-btn:hover:not(:disabled) {
  background: var(--primary) !important;
  color: #fff !important;
  border-color: var(--primary) !important;
}

/* ——— 焦点环统一暖橙 ——— */
.primary-btn:focus-visible, .term-btn:focus-visible, .ghost-btn:focus-visible, .tpl-chip:focus-visible, .draft-select:focus-visible {
  outline: 0 !important;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 35%) !important;
}

/* ——— 图标按钮（App 头部）——— */
.theme-toggle, .trace-toggle, .settings-toggle, .ask-toggle, .timeline-toggle {
  background: transparent !important;
  border: 1px solid transparent !important;
  color: var(--text-2) !important;
  transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease !important;
}
.theme-toggle:hover, .trace-toggle:hover, .settings-toggle:hover, .ask-toggle:hover, .timeline-toggle:hover {
  background: rgb(255 255 255 / 6%) !important;
  color: var(--text) !important;
  border-color: rgb(255 255 255 / 10%) !important;
}

/* ——— 主色大按钮（FileList.save-btn / GeneratePanel.btn-primary）——— */
.save-btn, .btn-primary {
  background: var(--primary) !important;
  color: #fff !important;
  border: 0 !important;
  box-shadow: none !important;
  border-radius: 6px !important;
}
.save-btn:hover:not(:disabled), .btn-primary:hover:not(:disabled) {
  background: var(--primary-hover) !important;
  box-shadow: none !important;
}

/* ——— FileList 撤回按钮 ——— */
.undo-btn {
  background: transparent !important;
  border: 0 !important;
  color: var(--text-3) !important;
}
.undo-btn:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%) !important;
  color: var(--danger) !important;
}

/* ——— FileTree 刷新 ——— */
.refresh { background: transparent !important; border: 0 !important; color: var(--text-3) !important; }
.refresh:hover:not(:disabled) { background: rgb(255 255 255 / 6%) !important; color: var(--text) !important; }


/* [button-theme-v2] 主按钮去实底 */
.save-btn, .btn-primary {
  background: transparent !important;
  color: var(--primary) !important;
  border: 1px solid var(--primary) !important;
  box-shadow: none !important;
}
.save-btn:hover:not(:disabled), .btn-primary:hover:not(:disabled) {
  background: var(--primary-bg) !important;
  color: var(--primary-hover) !important;
  border-color: var(--primary-hover) !important;
  box-shadow: none !important;
}

</style>
<!-- tooltip-audit -->
