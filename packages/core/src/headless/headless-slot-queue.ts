// [headless-slot-queue-v1] 无头池的并发槽位队列。
// [WHY] ai-headless.ts 略超 §4 模块 400 行；acquireSlot/releaseSlot 无池状态依赖，可独立。
// [CONSTRAINT] 池满时排队等待，超时 resolve（不 reject）；与 releaseSlot 配对消费队列头部。
// [CHANGE-IMPACT] ai-headless.ts 用 createSlotQueue 创建实例，语义不变。

export interface SlotQueue {
  /** 尝试获取槽位：池未满立即 resolve；否则排队等 timeoutMs */
  acquire: () => Promise<void>
  /** 释放一个槽位：唤醒队列头部等待者（若有） */
  release: () => void
  /** 当前是否池满（对外暴露用于判定能否立即进入） */
  isFull: (currentSize: number) => boolean
}

/**
 * 创建并发槽位队列
 * [WHY] 池大小固定，请求并发时需排队；超时后放行避免永久阻塞（由调用方最终走限流）
 * [CONSTRAINT] 队列元素为 { resolve, timer }；release 时先 clearTimeout 再 resolve
 * @param poolLimit 并发上限；达到该值即进入排队
 * @param queueTimeoutMs 排队等待上限（毫秒）
 */
export function createSlotQueue(poolLimit: number, queueTimeoutMs: number): SlotQueue {
  const waiting: Array<{ resolve: () => void, timer: ReturnType<typeof setTimeout> }> = []
  return {
    isFull: (currentSize: number) => currentSize >= poolLimit,
    acquire: (): Promise<void> => {
      // 注：调用方先自行判断 isFull；此处不做大小校验避免与外部状态竞争
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          const i = waiting.findIndex(w => w.resolve === resolve)
          if (i >= 0) waiting.splice(i, 1)
          resolve()
        }, queueTimeoutMs)
        waiting.push({ resolve, timer })
      })
    },
    release: () => {
      const next = waiting.shift()
      if (next) {
        clearTimeout(next.timer)
        next.resolve()
      }
    },
  }
}
