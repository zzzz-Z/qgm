// [run-queue-v1] 待执行脚本队列：上一轮未结束时到的脚本排队，本轮结束后自动出队执行。
//
// [WHY] 原实现在 useAiReplyHandlers 的 retryRun 里每秒轮询等 running 变 false，20 次后超时，
//   脚本滞留编辑器但**无人再执行**（工作台无「执行编辑器内容」入口）。排队是事件驱动的精确做法：
//   running 落 false 的同一处直接出队，无需轮询、无需超时，天然串行。
//
// [CONSTRAINT] 本模块零依赖（不 import vue / 项目 composables）——vitest 可裸跑真实驱动；
//   队列不参与 UI 渲染，故用普通数组而非 ref（避免无谓的响应式开销）。
// [CONSTRAINT] 上限 20 条：超出拒绝入队（防 AI 异常刷屏时无界堆积）。

/** 待执行项（与 useRunner.run 的 opts 子集对齐） */
export interface RunQueueItem {
  script: string
  runKey?: string
  autoFeedback?: boolean
}

export interface RunQueue {
  /** 入队；队列已满返回 false（调用方据此跳过） */
  enqueue: (item: RunQueueItem) => boolean
  /** 出队一条；空队列返回 null */
  dequeue: () => RunQueueItem | null
  size: () => number
  /** 清空（stop() 时调用，防停止后仍执行排队项） */
  clear: () => void
}

export const MAX_PENDING_RUNS = 20

/** 创建队列实例。max 可注入（测试用小值）。 */
export function createRunQueue(max = MAX_PENDING_RUNS): RunQueue {
  let buf: RunQueueItem[] = []
  return {
    enqueue(item: RunQueueItem): boolean {
      if (buf.length >= max) return false
      buf.push(item)
      return true
    },
    dequeue(): RunQueueItem | null {
      return buf.shift() ?? null
    },
    size: () => buf.length,
    clear(): void { buf = [] },
  }
}
