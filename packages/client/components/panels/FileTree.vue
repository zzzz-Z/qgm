<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useClipboard } from '@vueuse/core'
// [filetree-fold-v1] PLAN 5.4 目录展开态持久化
import { useFoldState } from '../../composables/ui/useFoldState'
import { highlightToHtml } from '../../composables/useHljs'
import { useFileTree } from '../../composables/data/useFileTree'
// [drag-controller-v1] 拖拽逻辑已抽到 drag-controller.ts
import { createDragController } from './drag-controller'
import type { FileNode } from '../../types'
/** 单条文件读取结果；content 缺失表示未读到（二进制/权限不足等） */
interface FileReadItem { path?: string, content?: string }
/** /__ai/files/read 的响应（兼容 {files:[...]} 与裸数组两种历史格式） */
interface FileReadResponse { files?: FileReadItem[] }

defineOptions({ name: 'FileTree' })

/** 向父组件请求打开"添加项目"流程（空工作区按钮触发） */
const emit = defineEmits<{
  addProject: []
}>()

/** 组件接收的 props 定义 */
const props = defineProps<{
  nodes?: FileNode[]
  depth?: number
  root?: boolean
  draggable?: boolean
}>()

const { tree, loading, copiedPath, load, loadChildren, getChildren, isChildrenLoading, copyPath } = useFileTree()

/** 当前工作区项目名；初值兜底 '工作区'，onMounted 后按 /__ai/workspace 或 package.json name 修正 */
const projectName = ref('工作区')

if (props.root) {
  onMounted(async () => {
    await load()
    // [root-name-v2] 优先用 /__ai/workspace 返回的 root 目录名；其次 package.json name
    try {
      const ws = await fetch('/__ai/workspace', { headers: { accept: 'application/json' } })
      if (ws.ok) {
        const wj = await ws.json() as { root?: string }
        const r = String(wj?.root || '').replace(/[\\/]+$/, '')
        if (r) {
          const parts = r.split('/').filter(Boolean)
          const base = parts[parts.length - 1] || ''
          if (base) projectName.value = base
        }
      }
    } catch { /* ignore */ }
    if (projectName.value === '工作区' || !projectName.value) {
      const pkgNode = tree.value.find(n => n.name === 'package.json')
      if (pkgNode) {
        try {
          const res = await fetch('/__ai/files/read', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ paths: [pkgNode.path] }),
          })
          if (res.ok) {
            const j = await res.json() as Record<string, unknown>
            const arr = (Array.isArray((j as FileReadResponse).files) ? (j as FileReadResponse).files : (Array.isArray(j) ? j : [])) as FileReadItem[]
            const hit = arr.find((x: FileReadItem) => x && x.path === pkgNode.path) || arr[0] || {}
            if (hit.content) {
              const parsed = JSON.parse(hit.content)
              if (parsed.name) projectName.value = String(parsed.name).split('/').pop() || String(parsed.name)
            }
          }
        } catch { /* ignore */ }
      }
    }
  })
}

/**
 * 执行 list
 */
function list(): FileNode[] { return props.root ? tree.value : (props.nodes || []) }
/**
 * 执行 level
 */
function level(): number { return props.depth || 0 }

// [filetree-fold-v1] 从 localStorage 恢复展开态
const fold = useFoldState('default', 'filetree')
/** 是否展开 */
const expanded = reactive(new Set<string>())
// 初始化：把所有 true 的 key 塞入 expanded
for (const [k, v] of Object.entries(fold.all.value)) {
  if (v) expanded.add(k)
}

/**
 * 执行 persist Expanded
 */
function _persistExpanded(): void {
  const map: Record<string, boolean> = {}
  for (const p of expanded) map[p] = true
  // [CONSTRAINT] 全量替换：fold 中未出现在 expanded 的 key 会被清除，
  // 即"折叠"是默认态，只持久化"展开"项（与 useFoldState 的 isOpen fallback 语义一致）
  fold.all.value = map
}

/**
 * 切换
 * @param p - p
 */
function toggle(p: string) {
  if (expanded.has(p)) {
    expanded.delete(p)
  } else {
    expanded.add(p)
    loadChildren(p)
  }
  _persistExpanded()
}

/**
 * 判断是否为 Open
 * @param p - p
 */
function isOpen(p: string): boolean { return expanded.has(p) }

/** 根节点 */
const rootPath = computed(() => {
  if (!tree.value.length) return '.'
  const first = String(tree.value[0].path || '')
  if (!first.startsWith('/')) return '.'
  const idx = first.lastIndexOf('/')
  return idx > 0 ? first.slice(0, idx) : '.'
})

/** 根节点节点 */
const rootNode = computed(() => {
  if (!props.root) return null
  return {
    name: projectName.value,
    path: rootPath.value,
    type: 'directory'
  } as FileNode
})

/**
 * 获取 File Icon
 * @param name - name
 */
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

/** 文件树图标映射（按扩展名） */
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

/**
 * 执行 icon Svg
 * @param name - name
 * @param cls - cls
 */
function iconSvg(name: string, cls = ''): string {
  const d = ICONS[name] || ICONS.file
  return `<svg class="ft-icon ${cls}" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${d}</svg>`
}

// 收集目录下所有文件路径。因懒加载，目录的 children 可能未拉取，
// 所以遇目录时向后端请求完整子树（depth=32）。
/**
 * 收集 File Paths Async
 * @param node - node
 */
async function collectFilePathsAsync(node: FileNode): Promise<string[]> {
  if (node.type === 'file') return [node.path]
  try {
    const res = await fetch(`/__ai/files/tree?path=${encodeURIComponent(node.path)}`)
    if (!res.ok) return []
    const data = await res.json()
    const out: string[] = []
    const walk = (n: FileNode) => {
      if (n.type === 'file') out.push(n.path)
      else if (n.children?.length) n.children.forEach(walk)
    }
    for (const child of data.tree || []) walk(child)
    return out
  } catch {
    return []
  }
}

// [drag-controller-v1] 拖拽控制器（须在 rootNode/getFileIcon/iconSvg/collectFilePathsAsync/toggle/copyPath 声明之后）
const dragCtl = createDragController({
  isDraggable: () => !!props.draggable,
  rootNode,
  getFileIcon,
  iconSvg,
  collectFilePathsAsync,
  toggle,
  copyPath,
})
const { onRootPointerDown, onPointerDown } = dragCtl
onBeforeUnmount(() => dragCtl.dispose())

// [file-dialog] 双击文件弹窗查看详情 + 复制
/** 双击文件后的查看弹窗状态；null 表示未打开 */
const fileDialog = ref<{ path: string, content: string } | null>(null)
/** 文件内容请求中标志；用于显示"加载中"占位 */
const fileLoading = ref(false)
/** 文件内容读取失败原因（HTTP status 或 Error.message） */
const fileError = ref('')
/**
 * 响应 File Dbl Click
 * @param node - node
 * @param path - path
 */
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
    const arr = (Array.isArray((j as FileReadResponse).files) ? (j as FileReadResponse).files : (Array.isArray(j) ? j : [])) as FileReadItem[]
    const hit = arr.find((x: FileReadItem) => x && x.path === node.path) || arr[0] || {}
    fileDialog.value = { path: node.path, content: String((hit as FileReadItem).content || '') }
  } catch (e) {
    fileError.value = e instanceof Error ? e.message : String(e)
  } finally {
    fileLoading.value = false
  }
}
/**
 * 关闭 File Dialog
 */
function closeFileDialog() { fileDialog.value = null }
/**
 * 复制弹窗中展示的文件内容到剪贴板
 * [copy-via-vueuse] 走 vueuse useClipboard：内部自动选择 navigator.clipboard 或 execCommand 回退，
 * 且组件卸载时自动解绑 copy 事件监听
 * [CONSTRAINT] 复制失败静默（无 UI 反馈），因为内容已可见、用户可手动选择复制
 */
async function copyFileContent() {
  if (!fileDialog.value) return
  try { await _clipboard.copy(fileDialog.value.content) } catch { /* ignore */ }
}

/** [copy-via-vueuse] 组件级单例；随组件卸载自动清理 copy 事件监听 */
const _clipboard = useClipboard()
/**
 * 响应 Dialog Key
 * @param e - e
 */
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
// [native-picker] 调用系统原生文件夹选择器（macOS osascript / Windows / Linux 各平台实现）；
// 不支持平台或用户取消时静默返回，本组件不提供浏览器式回退
/**
 * 执行 choose Workspace
 */
async function chooseWorkspace(): Promise<void> {
  try {
    const r = await fetch('/__ai/workspace/pick', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    // 204 = 用户取消
    if (r.status === 204) return
    if (r.ok) {
      const j = await r.json().catch(() => ({})) as { ok?: boolean, canceled?: boolean }
      if (j && j.ok) {
        // [auto-new-session-on-switch-v1] 切项目后：写标记，让 reload 后的 App 开新会话并连接
        try {
          sessionStorage.setItem('__ai_switch_project', '1')
          sessionStorage.setItem('__ai_switch_project_at', String(Date.now()))
        } catch { /* sessionStorage 不可用时退化为普通 reload */ }
        window.location.reload()
        return
      }
      // 兼容旧服务端：200 + { canceled: true }
      if (j && j.canceled) { /* silent */ }
    }
    // 501（不支持平台）/ 5xx：静默失败
  } catch {
    // 网络错误：静默
  }
}
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
      <button v-tooltip="'选择工作区目录'" class="refresh ws-btn" aria-label="选择工作区" @click="chooseWorkspace">
        <svg class="ft-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5a2 2 0 0 1 2-2h2.2a2 2 0 0 1 1.4.6l1.2 1.2a2 2 0 0 0 1.4.6H16a2 2 0 0 1 2 2v1" /><rect x="3" y="9.5" width="12" height="9.5" rx="2" /><line x1="19" y1="14" x2="19" y2="20" /><line x1="16" y1="17" x2="22" y2="17" /></svg>
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

<style scoped lang="scss" src="./FileTree.scss" />

<style lang="scss">
/* [drag-ghost-global-v1] ghost 挂载到 document.body，必须非 scoped 才能命中 */
// WHY: FileTree.scss 现由 scoped 引入，选择器会被加 [data-v-xxx]；ghost 无此属性 → 完全失效 → 拖动时鼠标旁看不到文件
// CONSTRAINT: 与 FileTree.scss 内同名规则并存（scoped 那份不生效），后续清理时先确认本块已生效再删旧版
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
  max-width: 320px;
  padding: 7px 14px;
  background: var(--surface);
  border: 1px solid rgb(37 99 235 / 40%);
  border-radius: var(--radius-8);
  box-shadow:
    0 8px 24px rgb(15 30 60 / 18%),
    0 0 0 3px rgb(37 99 235 / 10%);
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
