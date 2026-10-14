// [drag-controller-v1] 从 FileTree.vue 抽出：树节点拖拽（ghost / pointer 事件 / drop 派发）
// [ui-p2a-drag-bus-wire-v1] V12：drop 改走显式通道；drag / drag-cancel 无任何消费者，删除
import { emitTreeDrop } from '../../composables/ui/drag-bus'
import type { FileNode } from '../../types'

/** 拖拽状态（内部） */
interface DragState {
  node: FileNode
  paths: string[]
  startX: number
  startY: number
  moved: boolean
}

/** 拖拽控制器依赖面 */
export interface DragControllerDeps {
  /** 组件是否开启可拖拽（来自 props） */
  isDraggable: () => boolean
  getFileIcon: (name: string) => string
  iconSvg: (name: string, cls?: string) => string
  collectFilePathsAsync: (node: FileNode) => Promise<string[]>
  toggle: (path: string) => void
  copyPath: (path: string) => void
}

/**
 * 创建拖拽控制器
 * @param deps - 依赖面
 */
export function createDragController(deps: DragControllerDeps) {
  const { isDraggable, getFileIcon, iconSvg, collectFilePathsAsync, toggle, copyPath } = deps
  let drag: DragState | null = null
  let ghost: HTMLElement | null = null

  /** 创建跟随鼠标的 ghost 元素（含图标 + 标签） */
  function createGhost(node: FileNode, count: number): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ai-runner-drag-ghost'
    const isDir = node.type === 'directory'
    const svgName = isDir ? 'folder' : getFileIcon(node.name)
    const label = isDir
      ? (count > 0 ? `${node.name}/ · ${count} 个文件` : `${node.name}/ · 加载中…`)
      : node.name
    // [ghost-xss-fix-v1] label 含未转义的 node.name；磁盘上存在形如 <img onerror> 的文件名时，
    // 拖拽即在工作台 origin 执行脚本（报告 §2.15）。改为 SVG（白名单）+ textContent 两段写入。
    el.innerHTML = iconSvg(svgName, 'ghost-svg')
    const labelEl = document.createElement('span')
    labelEl.className = 'ghost-label'
    labelEl.textContent = label
    el.appendChild(labelEl)
    document.body.appendChild(el)
    // [ghost-update-v1] 首帧 drag.paths 通常是空（collectFilePathsAsync 未返回），
    // 报告 §2.16：ghost 永远显示"加载中…"。挂 update 回调供 resolve 后刷新文案。
    ;(el as HTMLElement & { __updateLabel?: (s: string) => void }).__updateLabel = (s: string) => {
      labelEl.textContent = s
    }
    return el
  }

  /** 跟随鼠标移动 ghost */
  function moveGhost(x: number, y: number): void {
    if (!ghost) return
    ghost.style.transform = `translate3d(${x + 14}px, ${y + 14}px, 0)`
  }

  /** 淡出并销毁 ghost */
  function destroyGhost(): void {
    if (ghost) {
      ghost.style.opacity = '0'
      const g = ghost
      setTimeout(() => g.remove(), 120)
      ghost = null
    }
  }

  /** 拖拽期间锁定页面（加全局 class） */
  function lockPage(): void {
    document.documentElement.classList.add('ai-runner-dragging')
  }

  /** 解除页面锁定 */
  function unlockPage(): void {
    document.documentElement.classList.remove('ai-runner-dragging')
  }

  /** 节点按下：建立 drag 状态、异步拉目录 paths、注册全局监听 */
  function onPointerDown(e: PointerEvent, node: FileNode): void {
    if (!isDraggable()) return
    if (e.button !== 0) return
    drag = { node, paths: [], startX: e.clientX, startY: e.clientY, moved: false }
    if (node.type === 'directory') {
      collectFilePathsAsync(node).then((paths) => {
        if (drag && drag.node.path === node.path) drag.paths = paths
        // [ghost-update-v1] paths 到达后刷新 ghost 文案（首帧通常为 0）
        const g = ghost as (HTMLElement & { __updateLabel?: (s: string) => void }) | null
        if (g && typeof g.__updateLabel === 'function') {
          const n = paths.length
          g.__updateLabel(n > 0 ? `${node.name}/ · ${n} 个文件` : node.name)
        }
      })
    } else {
      drag.paths = [node.path]
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerCancel)
  }

  /** 移动：超过 4px 才视为拖拽 */
  function onPointerMove(e: PointerEvent): void {
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
    e.preventDefault()
  }

  /** 松开：未移动则视为点击（目录切换展开 / 文件复制路径）；移动则派发树拖拽落点 */
  function onPointerUp(e: PointerEvent): void {
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
    emitTreeDrop({ paths: d.paths, primary: d.node.path, x: e.clientX, y: e.clientY })
  }

  /** 取消拖拽：仅清理本地状态（落点通道不感知取消） */
  function onPointerCancel(): void {
    cleanup()
    drag = null
  }

  /** 清理监听 + 销毁 ghost + 解锁页面（幂等） */
  function cleanup(): void {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    destroyGhost()
    unlockPage()
  }

  /** 组件卸载时调用：清理并清空 drag */
  function dispose(): void {
    cleanup()
    drag = null
  }

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, cleanup, dispose }
}
