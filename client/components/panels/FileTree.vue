<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { highlightToHtml } from '../../composables/useHljs'
import { useFileTree } from '../../composables/data/useFileTree'
import type { FileNode } from '../../types'

defineOptions({ name: 'FileTree' })

const emit = defineEmits<{
  addProject: []
}>()

const props = defineProps<{
  nodes?: FileNode[]
  depth?: number
  root?: boolean
  draggable?: boolean
}>()

const { tree, loading, copiedPath, load, loadChildren, getChildren, isChildrenLoading, copyPath } = useFileTree()

const projectName = ref('工作区')

if (props.root) {
  onMounted(async () => {
    await load()
    // [ensure-project-name] 尝试从 package.json 获取项目名
    if (projectName.value === '工作区') {
      const pkgNode = tree.value.find(n => n.name === 'package.json')
      if (pkgNode) {
        try {
          const res = await fetch('/__ai/files/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paths: [pkgNode.path] })
          })
          if (res.ok) {
            const j = await res.json() as Record<string, unknown>
            const arr = Array.isArray((j as any).files) ? (j as any).files : (Array.isArray(j) ? j : [])
            const hit = arr.find((x: any) => x && x.path === pkgNode.path) || arr[0] || {}
            if (hit.content) {
              const parsed = JSON.parse(hit.content)
              if (parsed.name) projectName.value = String(parsed.name).split('/').pop() || String(parsed.name)
            }
          }
        } catch {
          // ignore
        }
      }
    }
    try {
      const res = await fetch('/__ai/files/read', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: ['package.json'] })
      })
      if (res.ok) {
        const j = await res.json() as Record<string, unknown>
        const arr = Array.isArray((j as any).files) ? (j as any).files : (Array.isArray(j) ? j : [])
        const hit = arr.find((x: any) => x && x.path === 'package.json') || arr[0] || {}
        if (hit.content) {
          const parsed = JSON.parse(hit.content)
          if (parsed.name) {
            projectName.value = String(parsed.name).split('/').pop() || String(parsed.name)
          }
        }
      }
    } catch {
      // ignore
    }
  })
}

const list = () => props.root ? tree.value : (props.nodes || [])
const level = () => props.depth || 0

const expanded = reactive(new Set<string>())

function toggle(p: string) {
  if (expanded.has(p)) {
    expanded.delete(p)
  } else {
    expanded.add(p)
    loadChildren(p)
  }
}

const isOpen = (p: string) => expanded.has(p)

const rootPath = computed(() => {
  if (!tree.value.length) return '.'
  const first = String(tree.value[0].path || '')
  if (!first.startsWith('/')) return '.'
  const idx = first.lastIndexOf('/')
  return idx > 0 ? first.slice(0, idx) : '.'
})

const rootNode = computed(() => {
  if (!props.root) return null
  return {
    name: projectName.value,
    path: rootPath.value,
    type: 'directory'
  } as FileNode
})

// ---------- SVG 图标系统 ----------
function getFileIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.endsWith('.vue')) return 'vue'
  if (n.endsWith('.ts') || n.endsWith('.tsx')) return 'ts'
  if (n.endsWith('.js') || n.endsWith('.jsx') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'js'
  if (/.(?:css|scss|sass|less)$/.test(n)) return 'style'
  if (n.endsWith('.json')) return 'json'
  if (n.endsWith('.md')) return 'md'
  if (/.html?$/.test(n)) return 'html'
  if (/.(?:png|jpg|jpeg|gif|svg|webp|ico)$/.test(n)) return 'image'
  if (/.(?:yaml|yml)$/.test(n)) return 'config'
  if (n === 'package.json' || n === 'pnpm-lock.yaml') return 'pkg'
  if (n.startsWith('.') || n === 'tsconfig.json' || n === 'vite.config.ts' || n === 'eslint.config.ts') return 'config'
  return 'file'
}

const ICONS: Record<string, string> = {
  vue: '<path fill="#42b883" d="M2 2h4l6 10 6-10h4L12 22 2 2z"/><path fill="#35495e" d="M4.5 2h3L12 10l4.5-8h3L12 18 4.5 2z"/>',
  ts: '<path fill="#3178c6" d="M2 2h20v20H2V2zm10 14h-2v-4H8v-2h6v2h-2v4zm4-6h-2v6h-2v-6h-2V8h6v2z"/>',
  js: '<path fill="#f7df1e" d="M2 2h20v20H2V2zm14.5 15c0-1.5-1-2.2-2.5-2.8l-.8-.4c-.7-.3-1-.6-1-1.1 0-.5.4-.9 1.1-.9.7 0 1.2.4 1.3 1h1.8c-.1-1.4-1.2-2.3-3-2.3-1.7 0-2.9 1-2.9 2.5 0 1.4 1 2.1 2.4 2.7l.9.4c.7.3 1 .7 1 1.2 0 .6-.5 1-1.3 1-.9 0-1.4-.5-1.5-1.2h-1.9c.1 1.6 1.3 2.6 3.3 2.6 1.8 0 3.1-1 3.1-2.7zM9 17H7v-7H5V8h4v2H9v7z"/>',
  style: '<path fill="#563d7c" d="M12 2L2 6l2 12 8 4 8-4 2-12-10-4zm0 2.3l7.5 3-1.5 9L12 19l-6-2.7-1.5-9L12 4.3z"/>',
  json: '<path fill="#cbcb41" d="M4 4h16v16H4V4zm3 10c0-1.5 1-2.5 2.5-2.5S12 12.5 12 14s-1 2.5-2.5 2.5S7 15.5 7 14zm5 0c0-1.5 1-2.5 2.5-2.5s2.5 1 2.5 2.5-1 2.5-2.5 2.5-2.5-1-2.5-2.5z"/>',
  md: '<path fill="#519aba" d="M4 4h16v16H4V4zm3 12V8l3 4 3-4v8h-2v-5l-1 1.5L9 11v5H7zm8 0h-2v-4h2v4z"/>',
  html: '<path fill="#e34c26" d="M4 2l1.8 18L12 22l6.2-2L20 2H4zm12.5 15.5L12 19l-4.5-1.5L6.8 5h10.4l-.7 12.5z"/>',
  image: '<path fill="#a074c4" d="M4 4h16v16H4V4zm3 12l3-4 2 2.5 3-4 3 5.5H7z"/>',
  config: '<path fill="#858585" d="M12 2a10 10 0 100 20 10 10 0 000-20zm0 3a2 2 0 110 4 2 2 0 010-4zm0 10a5 5 0 01-4-2h8a5 5 0 01-4 2z"/>',
  pkg: '<path fill="#cb3837" d="M4 4h16v16H4V4zm3 3v10h10V7H7zm2 2h6v6H9V9z"/>',
  file: '<path fill="#9ca3af" d="M6 2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm7 1v5h5"/>',
  folder: '<path fill="#dcb67a" d="M2 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>',
  folderOpen: '<path fill="#dcb67a" d="M2 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v1H8l-2 3H2V6zm0 7h6l2-3h10v7a2 2 0 01-2 2H4a2 2 0 01-2-2v-7z"/>',
  chevronRight: '<path fill="currentColor" d="M9 6l6 6-6 6V6z"/>',
}

function iconSvg(name: string, cls = ''): string {
  const d = ICONS[name] || ICONS.file
  return `<svg class="ft-icon ${cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${d}</svg>`
}

// ---------- pointer 拖拽 + ghost ----------
interface DragState {
  node: FileNode
  paths: string[]
  startX: number
  startY: number
  moved: boolean
}

let drag: DragState | null = null
let ghost: HTMLElement | null = null

// 收集目录下所有文件路径。因懒加载，目录的 children 可能未拉取，
// 所以遇目录时向后端请求完整子树（depth=32）。
async function collectFilePathsAsync(node: FileNode): Promise<string[]> {
  if (node.type === 'file') return [node.path]
  try {
    const res = await fetch(`/__ai/files/tree?path=${encodeURIComponent(node.path)}`)
    if (!res.ok) return []
    const data = await res.json()
    const out: string[] = []
    const walk = (n: any) => {
      if (n.type === 'file') out.push(n.path)
      else if (n.children?.length) n.children.forEach(walk)
    }
    for (const child of data.tree || []) walk(child)
    return out
  } catch {
    return []
  }
}

function createGhost(node: FileNode, count: number) {
  const el = document.createElement('div')
  el.className = 'ai-runner-drag-ghost'
  const isDir = node.type === 'directory'
  const svgName = isDir ? 'folder' : getFileIcon(node.name)
  const label = isDir
    ? (count > 0 ? `${node.name}/ · ${count} 个文件` : `${node.name}/ · 加载中…`)
    : node.name
  el.innerHTML = `${iconSvg(svgName, 'ghost-svg')}<span class="ghost-label">${label}</span>`
  document.body.appendChild(el)
  return el
}

function moveGhost(x: number, y: number) {
  if (!ghost) return
  ghost.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`
}

function destroyGhost() {
  if (ghost) {
    ghost.style.opacity = '0'
    const g = ghost
    setTimeout(() => g.remove(), 120)
    ghost = null
  }
}

function lockPage() {
  document.documentElement.classList.add('ai-runner-dragging')
}
function unlockPage() {
  document.documentElement.classList.remove('ai-runner-dragging')
}

function onRootPointerDown(e: PointerEvent) {
  if (!props.draggable) return
  if (e.button !== 0) return
  const node = rootNode.value
  if (!node) return
  onPointerDown(e, node as FileNode)
}

function onPointerDown(e: PointerEvent, node: FileNode) {
  if (!props.draggable) return
  if (e.button !== 0) return

  // 立即建立 drag 状态（paths 暂空），异步拉完后填入。
  // 拖动时若 paths 仍空，ghost 显示"加载中…"。
  drag = {
    node,
    paths: [],
    startX: e.clientX,
    startY: e.clientY,
    moved: false,
  }

  if (node.type === 'directory') {
    collectFilePathsAsync(node).then((paths) => {
      if (drag && drag.node.path === node.path) {
        drag.paths = paths
      }
    })
  } else {
    drag.paths = [node.path]
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
}

function onPointerMove(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.startX
  const dy = e.clientY - drag.startY

  if (!drag.moved && Math.hypot(dx, dy) < 4) return
  if (!drag.moved) {
    drag.moved = true
    ghost = createGhost(drag.node, drag.paths.length)
    moveGhost(e.clientX, e.clientY)
    lockPage()
  }

  moveGhost(e.clientX, e.clientY)

  window.dispatchEvent(new CustomEvent('ai-runner:drag', {
    detail: {
      primary: drag.node.path,
      type: drag.node.type,
      count: drag.paths.length,
      x: e.clientX,
      y: e.clientY,
    },
  }))
  e.preventDefault()
}

function onPointerUp(e: PointerEvent) {
  const wasMoved = drag?.moved
  const d = drag
  cleanup()
  drag = null
  if (!d || !wasMoved) {
    if (d) {
      if (d.node.type === 'directory') toggle(d.node.path)
      else copyPath(d.node.path)
    }
    return
  }

  window.dispatchEvent(new CustomEvent('ai-runner:drop', {
    detail: {
      paths: d.paths,
      primary: d.node.path,
      x: e.clientX,
      y: e.clientY,
    },
  }))
}

function onPointerCancel() {
  cleanup()
  drag = null
  window.dispatchEvent(new CustomEvent('ai-runner:drag-cancel'))
}

function cleanup() {
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  window.removeEventListener('pointercancel', onPointerCancel)
  destroyGhost()
  unlockPage()
}

onBeforeUnmount(() => {
  cleanup()
  drag = null
})

// [file-dialog] 双击文件弹窗查看详情 + 复制
const fileDialog = ref<{ path: string, content: string } | null>(null)
const fileLoading = ref(false)
const fileError = ref('')
async function onFileDblClick(node: { type?: string, path: string }) {
  if (!node || node.type === 'directory') return
  fileDialog.value = { path: node.path, content: '' }
  fileLoading.value = true
  fileError.value = ''
  try {
    const r = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [node.path] }),
    })
    if (!r.ok) { fileError.value = `HTTP ${r.status}`; return }
    const j = await r.json() as Record<string, unknown>
    const arr = Array.isArray((j as any).files) ? (j as any).files : (Array.isArray(j) ? j : [])
    const hit = arr.find((x: any) => x && x.path === node.path) || arr[0] || {}
    fileDialog.value = { path: node.path, content: String((hit as any).content || '') }
  } catch (e) {
    fileError.value = e instanceof Error ? e.message : String(e)
  } finally {
    fileLoading.value = false
  }
}
function closeFileDialog() { fileDialog.value = null }
async function copyFileContent() {
  if (!fileDialog.value) return
  try { await navigator.clipboard.writeText(fileDialog.value.content) } catch { /* ignore */ }
}
function onDialogKey(e: KeyboardEvent) { if (e.key === 'Escape') closeFileDialog() }

// [ft-hljs] 弹窗内容按 hljs 高亮（与 DiffViewer 同款）
const fileDialogHtml = computed(() => {
  const c = fileDialog.value?.content || ''
  if (!c) return ''
  try {
    return highlightToHtml(c)
  } catch {
    return c.replace(/[&<>]/g, m => (m === '&' ? '&amp;' : m === '<' ? '&lt;' : '&gt;'))
  }
})
</script>

<template>
  <div class="tree" :class="{ 'is-root': props.root }">
    <div v-if="props.root" class="tree-head">
      <div
        v-if="rootNode"
        v-tooltip="props.draggable ? `拖动到左侧：${rootNode.path}` : rootNode.path"
        class="row dir root-row"
        :class="{ 'is-draggable': props.draggable }"
        @pointerdown="onRootPointerDown"
      >
        <span class="icon" v-html="iconSvg('folder')" />
        <span class="name">{{ rootNode.name }}</span>
      </div>
      <button v-tooltip="loading ? '正在刷新…' : '重新拉取文件树（清空懒加载缓存）'" class="refresh" aria-label="刷新文件树" :disabled="loading" @click="load">
        <svg class="ft-icon refresh-svg" viewBox="0 0 24 24"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></svg>
      </button>
    </div>

    <div v-if="props.root && loading && !tree.length" class="empty">
      <svg class="ft-icon empty-icon spin" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4V2A10 10 0 002 12h2a8 8 0 018-8z" /></svg>
      <span>加载中…</span>
    </div>
    <!-- [fix-tree-title] 空工作区：添加项目 -->
    <div v-else-if="props.root && !tree.length" class="empty empty-workspace">
      <svg class="empty-workspace-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        <line x1="12" y1="11" x2="12" y2="17" />
        <line x1="9" y1="14" x2="15" y2="14" />
      </svg>
      <span class="empty-workspace-text">还没有添加项目</span>
      <button class="empty-workspace-btn" type="button" @click="emit('addProject')">
        添加项目到工作区
      </button>
    </div>

    <ul v-else class="list">
      <li v-for="node in list()" :key="node.path" class="item">
        <template v-if="node.type === 'directory'">
          <div
            v-tooltip="props.draggable ? (`拖动到左侧或点击展开：${node.path}`) : node.path"
            class="row dir"
            :class="{ 'is-draggable': props.draggable, 'is-open': isOpen(node.path) }"
            :style="{ '--depth': level() }"
            @pointerdown="onPointerDown($event, node)"
          >
            <!-- 层级引导线 -->
            <span v-for="i in level()" :key="i" class="guide" :style="{ '--i': i }" />
            <span class="arrow" :class="{ open: isOpen(node.path) }">
              <svg class="ft-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M9 6l6 6-6 6V6z" /></svg>
            </span>
            <span class="icon" v-html="iconSvg(isOpen(node.path) ? 'folderOpen' : 'folder')" />
            <span class="name">{{ node.name }}</span>
          </div>
          <FileTree
            v-if="isOpen(node.path) && getChildren(node.path).length"
            :nodes="getChildren(node.path)"
            :depth="level() + 1"
            :draggable="props.draggable"
          />
          <div
            v-else-if="isOpen(node.path) && isChildrenLoading(node.path)"
            class="loading-children"
            :style="{ '--depth': level() + 1 }"
          >
            加载中…
          </div>
        </template>

        <div
          v-else
          v-tooltip="props.draggable ? (`拖动到左侧或点击复制路径：${node.path}`) : node.path"
          class="row file"
          :class="{ 'is-draggable': props.draggable }"
          :style="{ '--depth': level() }"
          @dblclick="onFileDblClick(node)"
          @pointerdown="onPointerDown($event, node)"
        >
          <span v-for="i in level()" :key="i" class="guide" :style="{ '--i': i }" />
          <span class="arrow placeholder" />
          <span class="icon" v-html="iconSvg(getFileIcon(node.name))" />
          <span class="name">{{ node.name }}</span>
          <span v-if="copiedPath === node.path" class="copied-badge">已复制</span>
        </div>
      </li>
    </ul>
  </div>
  <Teleport to="body">
    <div v-if="fileDialog" class="ft-mask" tabindex="-1" @click.self="closeFileDialog" @keydown="onDialogKey">
      <div class="ft-card" role="dialog" aria-modal="true">
        <div class="ft-head">
          <span class="ft-path" :title="fileDialog.path">{{ fileDialog.path }}</span>
          <button v-tooltip="'复制到剪贴板'" class="ft-btn" @click="copyFileContent">
            复制
          </button>
          <button class="ft-btn ft-close" aria-label="关闭" @click="closeFileDialog">
            ×
          </button>
        </div>
        <div class="ft-body">
          <div v-if="fileLoading" class="ft-loading">
            加载中…
          </div>
          <div v-else-if="fileError" class="ft-error">
            {{ fileError }}
          </div>
          <pre v-else class="ft-pre" v-html="fileDialogHtml" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss">
:deep(.ft-icon) {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-block;
  vertical-align: middle;
}

.tree {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);

  padding: 4px 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.tree.is-root {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.tree.is-root > .tree-head .subtitle {
  font-size: 10px;
  color: var(--text-3);
  opacity: 0.7;
  font-weight: 400;
  letter-spacing: 0;
  text-transform: none;
  margin-left: 4px;
}
.empty-workspace {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 40px 20px;
  color: var(--text-3);
}
.empty-workspace-icon {
  width: 48px;
  height: 48px;
  opacity: 0.4;
}
.empty-workspace-text {
  font-size: 12px;
  color: var(--text-3);
}
.empty-workspace-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 14px;
  border: 1px solid var(--primary);
  border-radius: var(--radius-6);
  background: transparent;
  color: var(--primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.12s;
}
.empty-workspace-btn:hover {
  background: var(--primary-bg);
}
.tree-head {
  border-bottom: 0;
  margin-bottom: 2px;
  padding: 4px 6px 6px;
}

.tree-head {
  display: flex;
  align-items: center;
  gap: 6px;

  padding: 5px 10px 7px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.title {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
.tip {
  font-size: 13px;
  color: var(--text-3);
  margin-left: auto;
  opacity: 0.7;
}
.refresh {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-4);
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  transition: all 0.15s;
}
.refresh:hover:not(:disabled) {
  background: var(--primary-bg);
  color: var(--primary);
}
.refresh:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.refresh-svg {
  width: 14px;
  height: 14px;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.item {
  list-style: none;
}

.row {
  display: flex;
  align-items: center;
  gap: 2px;

  padding: 1px 8px 1px calc(var(--depth) * 16px + 8px);
  font-size: 13px;
  line-height: 20px;
  cursor: pointer;
  user-select: none;
  transition: background 0.08s;
  position: relative;
  white-space: nowrap;
}
.row:hover {
  background: var(--surface-2);
}
.row.dir {
  color: var(--text);
  font-weight: 500;
}
.row.file {
  color: var(--text-2);
}
.row.is-draggable {
  cursor: grab;
}
.row.is-draggable:hover {
  background: var(--primary-bg);
}
.row.is-draggable:active {
  cursor: grabbing;
}

.guide {
  position: absolute;
  left: calc((var(--i) - 1) * 18px + 19px);
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
  pointer-events: none;
  opacity: 0.8;
}
.row:hover ~ .guide,
.row:hover .guide {
  opacity: 1;
  background: var(--primary);
}

.row:hover .guide {
  opacity: 1;
  background: var(--primary);
}

.arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--text-3);
  transition: transform 0.15s ease;
}
.arrow .ft-icon {
  width: 10px;
  height: 10px;
}
.arrow.open {
  transform: rotate(90deg);
}
.arrow.placeholder {
  visibility: hidden;
}

.icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  margin-right: 4px;
}
.icon :deep(.ft-icon) {
  width: 16px;
  height: 16px;
}

.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

@keyframes badge-in {
  from {
    opacity: 0;
    transform: scale(0.8);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 12px;
  color: var(--text-3);
  font-size: 13px;
}
.empty-icon {
  width: 16px;
  height: 16px;
}
.loading-children {
  padding: 4px 10px 4px calc((var(--depth)) * 18px + 30px);
  font-size: 13px;
  color: var(--text-3);
  font-style: italic;
}
.spin {
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

<!-- 全局样式：拖拽 ghost + 拖拽期间锁定页面 -->
<style>
html.ai-runner-dragging,
html.ai-runner-dragging * {
  cursor: grabbing;
  user-select: none;
}
html.ai-runner-dragging,
html.ai-runner-dragging body {
  overflow: hidden;
  overscroll-behavior: none;
}

.ai-runner-drag-ghost {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 2147483000;
  pointer-events: none;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  padding: 7px 14px;
  background: var(--surface);
  border: 1px solid rgb(37 99 235 / 30%);
  border-radius: var(--radius-8);
  box-shadow:
    0 8px 24px rgb(15 30 60 / 18%),
    0 0 0 3px rgb(37 99 235 / 8%);
  /* P2-1 移除 backdrop-filter（GPU 性能负债）：backdrop-filter: blur(8px); */
  color: var(--text);
  font:
    12px/1.4 ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;
  transform: translate3d(0, 0, 0);
  transition: opacity 0.12s ease;
  will-change: transform;
  user-select: none;
}
.ai-runner-drag-ghost .ghost-svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.ai-runner-drag-ghost .ghost-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ═══════════════════════════════════════════════════════════
   [button-theme] 按钮配色重做：暖橙强调 + 灰阶次按钮
   参考 Claude Code / Codex 克制配色
   ═══════════════════════════════════════════════════════════ */

/* ——— 次按钮：透明底 + 细边框，hover 时淡淡提亮 ——— */
.ghost-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  border-radius: var(--radius-6);
  padding: 4px 10px;
  font-size: var(--font-12);
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.ghost-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 8%);
}
.ghost-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ——— 终端内按钮 ——— */
.term-btn {
  background: transparent;
  border: 1px solid rgb(255 255 255 / 8%);
  color: var(--text-2);
  border-radius: var(--radius-6);
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.term-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 14%);
}
.term-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.term-btn.copy,
.term-btn.ask-panel {
  color: var(--text-2);
  border-color: rgb(255 255 255 / 8%);
}
.term-btn.copy:hover:not(:disabled),
.term-btn.ask-panel:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 14%);
}

/* ——— 芯片 / 下拉 / tab ——— */
.tpl-chip {
  background: transparent;
  border: 1px solid rgb(255 255 255 / 8%);
  color: var(--text-2);
  border-radius: var(--radius-6);
}
.tpl-chip:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 14%);
}
.draft-select {
  background: transparent;
  border: 1px solid rgb(255 255 255 / 8%);
  color: var(--text-2);
  border-radius: var(--radius-6);
}
.draft-select:hover {
  border-color: rgb(255 255 255 / 14%);
}

/* ——— primary 系列（运行/主操作）：暖橙实底 ——— */
.primary-btn.run {
  background: var(--primary);
  color: #fff;
  box-shadow: none;
  border: 0;
}
.primary-btn.run:hover:not(:disabled) {
  background: var(--primary-hover);
  box-shadow: none;
}

/* 运行按钮（takeover 态）：暖橙描边，非实心，更克制 */
.primary-btn.takeover {
  background: transparent;
  color: var(--primary);
  border: 1px solid var(--primary);
  box-shadow: none;
}
.primary-btn.takeover:hover:not(:disabled) {
  background: rgb(217 119 87 / 12%);
  color: var(--primary-hover);
  border-color: var(--primary-hover);
}

/* 停止 / 暂停：柔和红描边 */
.primary-btn.stop {
  background: transparent;
  color: var(--danger);
  border: 1px solid var(--danger);
  box-shadow: none;
}
.primary-btn.stop:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%);
  color: #fff;
  border-color: var(--danger);
}

/* ——— loop-btn 系列 ——— */
.loop-btn {
  background: transparent;
  border: 1px solid rgb(255 255 255 / 8%);
  color: var(--text-2);
  border-radius: var(--radius-6);
  box-shadow: none;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.loop-btn:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 14%);
}
.loop-btn:active:not(:disabled) {
  box-shadow: none;
}
.loop-btn:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 30%);
}
.loop-btn:disabled {
  opacity: 0.4;
  background: transparent;
  color: var(--text-3);
}

.loop-btn.primary {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
  box-shadow: none;
}
.loop-btn.primary:hover:not(:disabled) {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
  color: #fff;
  box-shadow: none;
}
.loop-btn.kill,
.loop-btn.rollback {
  background: transparent;
  border-color: rgb(224 108 117 / 55%);
  color: var(--danger);
  box-shadow: none;
}
.loop-btn.kill:hover:not(:disabled),
.loop-btn.rollback:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%);
  border-color: var(--danger);
  color: #fff;
  box-shadow: none;
}

/* ——— 决策按钮 ——— */
.decision-btn {
  background: rgb(217 119 87 / 12%);
  color: var(--primary);
  border-color: var(--primary);
  font-weight: 600;
}
.decision-btn:hover:not(:disabled) {
  background: var(--primary);
  color: #fff;
  border-color: var(--primary);
}

/* ——— 焦点环统一暖橙 ——— */
.primary-btn:focus-visible,
.term-btn:focus-visible,
.ghost-btn:focus-visible,
.tpl-chip:focus-visible,
.draft-select:focus-visible {
  outline: 0;
  box-shadow: 0 0 0 2px rgb(217 119 87 / 35%);
}

/* ——— 图标按钮（App 头部）——— */
.theme-toggle,
.trace-toggle,
.settings-toggle,
.ask-toggle,
.timeline-toggle {
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-2);
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}
.theme-toggle:hover,
.trace-toggle:hover,
.settings-toggle:hover,
.ask-toggle:hover,
.timeline-toggle:hover {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
  border-color: rgb(255 255 255 / 10%);
}

/* ——— 主色大按钮（FileList.save-btn / GeneratePanel.btn-primary）——— */
.save-btn,
.btn-primary {
  background: var(--primary);
  color: #fff;
  border: 0;
  box-shadow: none;
  border-radius: var(--radius-6);
}
.save-btn:hover:not(:disabled),
.btn-primary:hover:not(:disabled) {
  background: var(--primary-hover);
  box-shadow: none;
}

/* ——— FileList 撤回按钮 ——— */
.undo-btn {
  background: transparent;
  border: 0;
  color: var(--text-3);
}
.undo-btn:hover:not(:disabled) {
  background: rgb(224 108 117 / 14%);
  color: var(--danger);
}

/* ——— FileTree 刷新 ——— */
.refresh {
  background: transparent;
  border: 0;
  color: var(--text-3);
}
.refresh:hover:not(:disabled) {
  background: rgb(255 255 255 / 6%);
  color: var(--text);
}

/* [file-dialog] 双击文件详情弹窗 */
.ft-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgb(0 0 0 / 55%);
  display: flex;
  align-items: center;
  justify-content: center;
}
.ft-card {
  width: min(880px, 92vw);
  max-height: 82vh;
  background: var(--surface, #1b1b1b);
  border: 1px solid var(--border, #333);
  border-radius: var(--radius-10);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 12px 40px rgb(0 0 0 / 40%);
}
.ft-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #333);
}
.ft-path {
  flex: 1;
  font-size: 13px;
  color: var(--text-2, #aaa);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ft-btn {
  background: transparent;
  color: var(--text-2, #aaa);
  border: 1px solid var(--border, #333);
  border-radius: var(--radius-6);
  font-size: 13px;
  padding: 3px 8px;
  cursor: pointer;
}
.ft-btn:hover {
  color: var(--text-1, #fff);
  border-color: var(--text-3, #666);
  background: rgb(255 255 255 / 6%);
}
.ft-close {
  padding: 3px 8px;
  font-size: 14px;
  line-height: 1;
}
.ft-body {
  padding: 8px 12px 12px;
  overflow: auto;
}
.ft-loading,
.ft-error {
  font-size: 13px;
  color: var(--text-3, #888);
  padding: 12px 0;
}
.ft-error {
  color: #ef4444;
}
.ft-pre {
  margin: 0;
  white-space: pre;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-1, inherit);
}

/* [ft-hljs] 弹窗内容 hljs 颜色（与 DiffViewer 一致） */
.tree-head .refresh {
  margin-left: auto;
}
/* [root-row-style] */
.tree-head .root-row {
  padding: 0;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
}
.tree-head .root-row .name {
  font-weight: 600;
}
</style>
<!-- tooltip-audit -->

<style>
/* [ft-hljs-global] FileTree 弹窗高亮颜色（全局，避免 Teleport + scoped :deep 失配） */
.ft-pre .hljs-keyword,
.ft-pre .hljs-literal {
  color: #569cd6;
}
.ft-pre .hljs-string {
  color: #ce9178;
}
.ft-pre .hljs-number {
  color: #b5cea8;
}
.ft-pre .hljs-comment {
  color: #6a9955;
  font-style: italic;
}
.ft-pre .hljs-function,
.ft-pre .hljs-title {
  color: #dcdcaa;
}
.ft-pre .hljs-variable,
.ft-pre .hljs-params,
.ft-pre .hljs-attr {
  color: #9cdcfe;
}
.ft-pre .hljs-built_in,
.ft-pre .hljs-type {
  color: #4ec9b0;
}
</style>
