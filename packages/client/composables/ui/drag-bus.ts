// [ui-p2a-drag-bus-v1] V12：树→编辑区拖拽落点从 window 字符串事件改为显式通道
// [WHY] 原 window.dispatchEvent(new CustomEvent('ai-runner:drop')) 无类型、跨组件不可追踪；
// 模块级订阅集合让「谁派发、谁消费」在 IDE 里可一跳定位。

/** 拖拽落点载荷（与 drag-controller 派发一致） */
export interface TreeDropDetail {
  paths: string[]
  primary: string
  x: number
  y: number
}

type TreeDropHandler = (detail: TreeDropDetail) => void

const handlers = new Set<TreeDropHandler>()

/** 派发一次树拖拽落点；无订阅者时静默（拖动到非编辑区属正常路径） */
export function emitTreeDrop(detail: TreeDropDetail): void {
  for (const handler of handlers) handler(detail)
}

/** 订阅树拖拽落点，返回取消订阅函数（须在 onBeforeUnmount 调用） */
export function subscribeTreeDrop(handler: TreeDropHandler): () => void {
  handlers.add(handler)
  return () => { handlers.delete(handler) }
}
