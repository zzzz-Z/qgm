<script setup lang="ts">
// [filetree-aria-v1] 报告 §5.3：树节点补 role/tabindex/aria-label/keydown，键盘可操作
// PLAN 5.4 目录展开态持久化
// .md 文件走 markdown 渲染；其余走 hljs 源码高亮
// 拖拽逻辑已抽到 drag-controller.ts
import { createDragController } from './drag-controller'
import { getFileIcon, iconSvg } from './file-tree-icons'
import type { FileNode } from '../../types'
import { TOAST_MEDIUM } from '../../utils/toast-durations'
// [ui-p1c-tree-expand-wire-v1] V4：展开态抽到同目录 composable（显式 import 兜住 vitest 无 auto-import）
import { useTreeExpand } from './use-tree-expand'
import { isMarkdownPath, renderFileContent } from '../../composables/useFileContentHtml'

defineOptions({ name: 'FileTree' })

// [ui-p2b-skeleton-wire-v1] V6 首屏骨架行数/宽度档位（静态常量，避免模板内重复字面量）
const SKELETON_ROWS = 6
const SKELETON_WIDTHS = ['sk-w-70', 'sk-w-40', 'sk-w-55', 'sk-w-85']

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

/** 单条文件读取结果；content 缺失表示未读到（二进制/权限不足等） */
interface FileReadItem { path?: string, content?: string }

/** /__ai/files/read 的响应（兼容 {files:[...]} 与裸数组两种历史格式） */
interface FileReadResponse { files?: FileReadItem[] }

// [copy-via-vueuse] 组件级单例 useClipboard：内部会注册 copy 事件监听，
// 通过 setup scope 在组件卸载时自动清理；因此必须定义在 setup 顶层而非函数内
const _clipboard = useClipboard()

// [choose-workspace-feedback-v1] 工作区选择失败需向用户提示：静默会让用户误以为按钮无响应
const { toast } = useToast()

const { tree, loading, copiedPath, load, loadChildren, getChildren, isChildrenLoading, copyPath } = useFileTree()

// 从 localStorage 恢复展开态
const fold = useFoldState('default', 'filetree')

/** 当前工作区项目名；初值兜底 '工作区'，onMounted 后按 /__ai/workspace 或 package.json name 修正 */
const projectName = ref('工作区')

// [ui-p1c-tree-expand-wire-v1] V4：展开态 + 持久化 + 懒加载触发统一由 composable 承载
const { toggle, isOpen, rehydrate } = useTreeExpand(fold, loadChildren)

// [file-dialog] 双击文件弹窗查看详情 + 复制
/** 双击文件后的查看弹窗状态；null 表示未打开 */
const fileDialog = ref<{ path: string, content: string } | null>(null)
/** 文件内容请求中标志；用于显示"加载中"占位 */
const fileLoading = ref(false)
/** 文件内容读取失败原因（HTTP status 或 Error.message） */
const fileError = ref('')
// [file-dialog-race-v1] 请求序号：双击 A 后快速双击 B，或关闭弹窗后旧响应返回，
// 原实现无条件写 fileDialog 会「用 A 的内容显示在 B 路径下」或「关闭后复活」（报告 §2.7）
let fileDialogSeq = 0

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

// [ft-hljs] 渲染分流复用 useFileContentHtml 的单点实现，避免与变更预览各写一份
const isMarkdown = computed(() => isMarkdownPath(fileDialog.value?.path || ''))

/** 渲染后的 HTML；.md 走 markdown，其余走 hljs 高亮 */
const fileDialogHtml = computed(() => renderFileContent(fileDialog.value?.content || '', fileDialog.value?.path || ''))

if (props.root) {
  onMounted(async () => {
    await load()
    // [expanded-rehydrate-v1] 刷新后 expanded 已从持久化恢复，但 loadChildren 从未被调过，
    // 子节点空 → 展开态但内容空白（报告 §2.5）。
    rehydrate()
    // 优先用 /__ai/workspace 返回的 root 目录名；其次 package.json name
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

// 拖拽控制器（须在 rootNode/getFileIcon/iconSvg/collectFilePathsAsync/toggle/copyPath 声明之后）
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

/**
 * 执行 list
 */
function list(): FileNode[] { return props.root ? tree.value : (props.nodes || []) }

/**
 * 执行 level
 */
function level(): number { return props.depth || 0 }

// [ui-p1c-tree-expand-wire-v1] 展开态/持久化/懒加载逻辑已迁至 use-tree-expand.ts

// 收集目录下所有文件路径。因懒加载，目录的 children 可能未拉取，
// 所以遇目录时向后端请求完整子树（depth=32）。
/**
 * 收集目录下所有文件路径（含懒加载未展开的子树）
 * [WHY] 拖拽目录时需要完整文件列表，但 tree 内存中仅有已展开的 children；向后端请求 depth=32 全量树兜底
 * [CONSTRAINT] 单次请求失败返回空数组，静默降级（拖拽会变成 no-op）
 * @param node 目录节点；node.type='file' 时直接返回 [node.path]
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

/**
 * 双击文件：拉取内容并在弹窗中展示（含 hljs 高亮）
 * [WHY] 快速预览文件内容 + 复制，避免切到编辑器
 * [CONSTRAINT] 目录节点直接返回；读取失败写入 fileError 供模板展示
 * [CHANGE-IMPACT] 会置 fileDialog / fileLoading / fileError 三个 ref，模板通过这三者判定状态
 * @param node 文件节点；type='directory' 时不响应
 */
async function onFileDblClick(node: { type?: string, path: string }) {
  if (!node || node.type === 'directory') return
  const seq = ++fileDialogSeq
  fileDialog.value = { path: node.path, content: '' }
  fileLoading.value = true
  fileError.value = ''
  try {
    const r = await fetch('/__ai/files/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [node.path] }),
    })
    if (!r.ok) { if (seq === fileDialogSeq) fileError.value = `HTTP ${r.status}`; return }
    const j = await r.json() as Record<string, unknown>
    const arr = (Array.isArray((j as FileReadResponse).files) ? (j as FileReadResponse).files : (Array.isArray(j) ? j : [])) as FileReadItem[]
    const hit = arr.find((x: FileReadItem) => x && x.path === node.path) || arr[0] || {}
    // [file-dialog-race-v1] 只有最新请求才能写 fileDialog
    if (seq !== fileDialogSeq) return
    fileDialog.value = { path: node.path, content: String((hit as FileReadItem).content || '') }
  } catch (e) {
    if (seq === fileDialogSeq) fileError.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === fileDialogSeq) fileLoading.value = false
  }
}

/**
 * 关闭 File Dialog
 */
function closeFileDialog() {
  // [file-dialog-race-v1] 关闭即让在飞请求失效，防旧响应复活弹窗
  fileDialogSeq += 1
  fileDialog.value = null
}

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

/**
 * 弹窗内键盘事件：仅响应 Escape 关闭
 * [CONSTRAINT] 不阻止其他按键冒泡（Enter / 复制快捷键交给浏览器默认行为）
 */
function onDialogKey(e: KeyboardEvent) { if (e.key === 'Escape') closeFileDialog() }

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
        // 切项目后：写标记，让 reload 后的 App 开新会话并连接
        try {
          sessionStorage.setItem('__ai_switch_project', '1')
          sessionStorage.setItem('__ai_switch_project_at', String(Date.now()))
        } catch { /* sessionStorage 不可用时退化为普通 reload */ }
        window.location.reload()
        return
      }
      if (j && j.canceled) return
    }
    // [choose-workspace-feedback-v1] 501 / 5xx 必须提示：
    // 用户点击后无 reload 也无提示会误判按钮失效；取消（204/200+canceled）仍保持静默
    if (r.status === 501) {
      toast('当前平台不支持系统选择器，请手动输入路径', 'warn', TOAST_MEDIUM)
      return
    }
    toast(`选择失败：HTTP ${r.status}`, 'error', TOAST_MEDIUM)
  } catch (e) {
    toast(`选择失败：${e instanceof Error ? e.message : String(e)}`, 'error', TOAST_MEDIUM)
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

    <!-- [ui-p2b-skeleton-wire-v1] V6：首屏改骨架屏，占位出「文件行」的形状 -->
    <div v-if="props.root && loading && !tree.length" class="skeleton-list" aria-busy="true" aria-label="正在加载文件树">
      <div
        v-for="sk in SKELETON_ROWS" :key="sk"
        class="skeleton-row"
        :style="{ '--sk-depth': sk % 3 === 0 ? 1 : 0 }"
      >
        <span class="skeleton-icon" />
        <span class="skeleton-line" :class="SKELETON_WIDTHS[sk % SKELETON_WIDTHS.length]" />
      </div>
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

    <ul v-else class="list" role="tree" aria-label="工作区文件树">
      <li v-for="node in list()" :key="node.path" class="item">
        <template v-if="node.type === 'directory'">
          <div
            v-tooltip="props.draggable ? (`拖动到左侧或点击展开：${node.path}`) : node.path"
            class="row dir"
            :class="{ 'is-draggable': props.draggable, 'is-open': isOpen(node.path) }"
            :style="{ '--depth': level() }"
            role="treeitem"
            :aria-label="node.path"
            :aria-expanded="isOpen(node.path)"
            tabindex="0"
            @keydown.enter.prevent="toggle(node.path)"
            @keydown.space.prevent="toggle(node.path)"
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
          role="treeitem"
          :aria-label="node.path"
          tabindex="0"
          @keydown.enter.prevent="onFileDblClick(node)"
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
          <!-- .md 用普通 div（<pre> 会禁掉标题/列表的默认排版）；其余用 <pre> 保源码缩进 -->
          <div v-else-if="isMarkdown" class="ft-md" v-html="fileDialogHtml" />
          <pre v-else class="ft-pre" v-html="fileDialogHtml" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped lang="scss" src="./file-tree.scss"></style>

<!-- [ghost-non-scoped-v1] ghost 挂载到 document.body，其样式必须非 scoped 才能命中。
     此处原为内联块，10-03 那轮样式抽离时被误合并进 file-tree.scss（且带上 <style> 标签 → sass 报
     "expected selector" 构建失败）。抽离只应搬 scoped 树样式，非 scoped 块必须留在 SFC 内。 -->
<style lang="scss">
/* ghost 挂载到 document.body，必须非 scoped 才能命中 */
// WHY: 树样式由 scoped 引入（file-tree.scss），选择器会被加 [data-v-xxx]；ghost 无此属性 → 完全失效 → 拖动时鼠标旁看不到文件
// CONSTRAINT: 本块必须保持非 scoped；scoped 引用里的同名规则一律不生效，以本块为准
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
  z-index: var(--z-toast);
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
