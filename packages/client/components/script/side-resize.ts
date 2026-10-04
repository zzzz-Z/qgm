// [side-resize-v1] 从 ScriptPanel.vue 抽出：侧栏拖拽改宽（pointer 事件）
import type { Ref } from 'vue'

/** 侧栏拖拽依赖面 */
export interface SideResizeDeps {
  paneRef: Ref<HTMLElement | null>
  sideWidth: Ref<number>
  sideWidthBase: Ref<number>
  resizingSide: Ref<boolean>
  /** 持久化回调（写入 localStorage） */
  persistWidth: (w: number) => void
}

/** 侧栏宽度的最小/最大比例（视觉合理区） */
const MIN_SIDE_WIDTH = 280
const MAX_SIDE_WIDTH_RATIO = 0.6
const HANDLE_CENTER_OFFSET = 7

/**
 * 创建侧栏拖拽控制器
 * @param deps - 依赖面
 */
export function createSideResize(deps: SideResizeDeps) {
  const { paneRef, sideWidth, sideWidthBase, resizingSide, persistWidth } = deps

  /** 计算并应用新宽度（基于鼠标位置） */
  function onSideMove(e: PointerEvent): void {
    if (!paneRef.value) return
    const rect = paneRef.value.getBoundingClientRect()
    const w = rect.right - e.clientX - HANDLE_CENTER_OFFSET
    sideWidth.value = Math.max(MIN_SIDE_WIDTH, Math.min(rect.width * MAX_SIDE_WIDTH_RATIO, w))
  }

  /** 松开/取消鼠标：结束拖拽、记录基准宽度、持久化、移除监听 */
  // [side-cancel-v1] 同时处理 pointerup 与 pointercancel：触摸/笔/窗口失焦会触发 cancel，
  // 原实现只挂 pointerup → resizingSide 永 true、window 监听残留、整页 cursor 粘死（报告 §2.9）
  function onSideUp(): void {
    resizingSide.value = false
    sideWidthBase.value = sideWidth.value
    persistWidth(sideWidth.value)
    window.removeEventListener('pointermove', onSideMove)
    window.removeEventListener('pointerup', onSideUp)
    window.removeEventListener('pointercancel', onSideUp)
  }

  /** 按下手柄：标记拖拽中、注册全局监听 */
  function onSideDown(e: PointerEvent): void {
    resizingSide.value = true
    window.addEventListener('pointermove', onSideMove)
    window.addEventListener('pointerup', onSideUp)
    window.addEventListener('pointercancel', onSideUp)
    e.preventDefault()
  }

  /** 组件卸载时移除可能残留的监听（拖拽中被销毁） */
  function dispose(): void {
    window.removeEventListener('pointermove', onSideMove)
    window.removeEventListener('pointerup', onSideUp)
    window.removeEventListener('pointercancel', onSideUp)
  }

  return { onSideDown, onSideMove, onSideUp, dispose }
}
