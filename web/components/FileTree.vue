<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue'
import { useFileTree } from '../composables/useFileTree'
import type { FileNode } from '../types'

defineOptions({ name: 'FileTree' })

const props = defineProps<{
  nodes?: FileNode[]
  depth?: number
  root?: boolean
  draggable?: boolean
}>()

const { tree, loading, copiedPath, load, loadChildren, getChildren, isChildrenLoading, copyPath } = useFileTree()

if (props.root) onMounted(load)

const list = () => props.root ? tree.value : (props.nodes || [])
const level = () => props.depth || 0

const expanded = reactive(new Set<string>())
if (props.root) {
  setTimeout(() => {
    const auto = ['src', 'plugins']
    tree.value.forEach((n) => {
      if (n.type === 'directory' && auto.includes(n.name)) {
        expanded.add(n.path)
        loadChildren(n.path)
      }
    })
  }, 100)
}

function toggle(p: string) {
  if (expanded.has(p)) {
    expanded.delete(p)
  } else {
    expanded.add(p)
    loadChildren(p)
  }
}

const isOpen = (p: string) => expanded.has(p)

// ---------- SVG 图标系统 ----------
function getFileIcon(name: string): string {
  const n = name.toLowerCase()
  if (n.endsWith('.vue')) return 'vue'
  if (n.endsWith('.ts') || n.endsWith('.tsx')) return 'ts'
  if (n.endsWith('.js') || n.endsWith('.jsx') || n.endsWith('.mjs') || n.endsWith('.cjs')) return 'js'
  if (/.(css|scss|sass|less)$/.test(n)) return 'style'
  if (n.endsWith('.json')) return 'json'
  if (n.endsWith('.md')) return 'md'
  if (/.(html?)$/.test(n)) return 'html'
  if (/.(png|jpg|jpeg|gif|svg|webp|ico)$/.test(n)) return 'image'
  if (/.(yaml|yml)$/.test(n)) return 'config'
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
</script>

<template>
  <div class="tree" :class="{ 'is-root': props.root }">
    <div v-if="props.root" class="tree-head">
      <span class="title">项目结构</span>
      <span v-if="props.draggable" class="tip">拖拽 → 左侧</span>
      <button v-tooltip="loading ? '正在刷新…' : '重新拉取文件树（清空懒加载缓存）'" class="refresh" :disabled="loading" @click="load">
        <svg class="ft-icon refresh-svg" viewBox="0 0 24 24"><path fill="currentColor" d="M17.65 6.35A7.96 7.96 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" /></svg>
      </button>
    </div>

    <div v-if="props.root && loading && !tree.length" class="empty">
      <svg class="ft-icon empty-icon spin" viewBox="0 0 24 24"><path fill="currentColor" d="M12 4V2A10 10 0 002 12h2a8 8 0 018-8z" /></svg>
      <span>加载中…</span>
    </div>
    <div v-else-if="props.root && !tree.length" class="empty">
      <span>无文件</span>
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
</template>

<style scoped lang="scss">
/* ========== 全局 SVG 图标基础 ========== */
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
  /* tighten-spacing */
  padding: 4px 0;
  flex: 1;
  min-height: 0;
  overflow: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

/* ========== Header ========== */
.tree-head {
  display: flex;
  align-items: center;
  gap: 6px;
  /* tighten-spacing */
  padding: 5px 10px 7px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.title {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.8px;
}
.tip {
  font-size: 10px;
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
  border-radius: 4px;
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

/* ========== List & Items ========== */
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
  /* tighten-spacing */
  padding: 1px 8px 1px calc(var(--depth) * 16px + 8px);
  font-size: 12px;
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

/* ========== Indent Guides ========== */
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
/* 当前行的所有 guide 高亮 */
.row:hover .guide {
  opacity: 1;
  background: var(--primary);
}

/* ========== Arrow ========== */
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

/* ========== Icon ========== */
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

/* ========== Name ========== */
.name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

/* ========== Copied Badge ========== */
.copied-badge {
  font-size: 9px;
  font-weight: 700;
  color: var(--success);
  background: var(--success-bg);
  padding: 1px 5px;
  border-radius: 3px;
  letter-spacing: 0.3px;
  flex-shrink: 0;
  animation: badge-in 0.2s ease-out;
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

/* ========== Empty State ========== */
.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 12px;
  color: var(--text-3);
  font-size: 12px;
}
.empty-icon {
  width: 16px;
  height: 16px;
}
.loading-children {
  padding: 4px 10px 4px calc((var(--depth)) * 18px + 30px);
  font-size: 11px;
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
  cursor: grabbing !important;
  user-select: none !important;
}
html.ai-runner-dragging,
html.ai-runner-dragging body {
  overflow: hidden !important;
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
  border-radius: 8px;
  box-shadow:
    0 8px 24px rgb(15 30 60 / 18%),
    0 0 0 3px rgb(37 99 235 / 8%);
  backdrop-filter: blur(8px);
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
</style>
<!-- tooltip-audit -->
