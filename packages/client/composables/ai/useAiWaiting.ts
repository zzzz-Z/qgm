import { effectScope, ref } from 'vue'
import { useSessionStorage, useTimeoutFn } from '@vueuse/core'

/** 跨组件共享的「等待 AI 回复」（单一数据源） */

// 3 分钟无回复则复位 waiting，避免永久卡死
const WATCHDOG_MS = 180_000
/** sessionStorage 键：loopPaused 持久化；刷新后仍保持暂停态 */
const LS_LOOP_PAUSED = '__ai_loop_paused'

/** 是否处于等待 AI 回复状态；内存态，不持久化 */
const waiting = ref(false)

// [module-scope-vueuse-timer] vueuse 定时器需在 effectScope 内创建；本模块为跨组件单例
// [WHY] useTimeoutFn 在组件 setup 内会注册 onScopeDispose；若模块首次导入发生在某组件 setup 中，
//       该组件卸载会连带清理 watchdog → 3 分钟兜底失效
// [CONSTRAINT] effectScope(true) 创建 detached scope；WATCHDOG_MS 为常量，无需动态延迟 ref
// [CHANGE-IMPACT] 原 watchdogTimer 显式句柄语义由 timeoutFn.start()/stop() 等价替代
const scope = effectScope(true)
const timeoutFn = scope.run(() => useTimeoutFn(() => {
  if (!waiting.value) return
  waiting.value = false
}, WATCHDOG_MS, { immediate: false }))!

/**
 * 暂停闸：阻断续推 / 发脚本 / 等待
 * [WHY] 走 vueuse useSessionStorage 替换原手工 sessionStorage + watch：
 * 自动惰性读写 + 序列化 + storage 事件跨标签页同步
 * [CONSTRAINT] 类型必须是 boolean 与下游引用一致；serializer 用 '1'/'0' 兼容历史持久化格式
 * [CHANGE-IMPACT] 多标签页共享 sessionStorage 时，一处改暂停会立即同步到另一处
 */
export const loopPaused = useSessionStorage<boolean>(LS_LOOP_PAUSED, false, {
  serializer: {
    read: raw => raw === '1',
    write: v => (v ? '1' : '0'),
  },
})

/**
 * 进入等待 AI 回复状态并重置看门狗
 * [WHY] 单独 startWaiting 与 useAiWaiting 返回的同名方法并存：供 transport 层在 setup 外直接调用
 * [CHANGE-IMPACT] 内部先 timeoutFn.stop() 再 start()，重复调用等价于续期
 */
export function startWaiting(): void {
  waiting.value = true
  armWatchdog()
}

/**
 * 取消看门狗定时器；幂等
 * [use-timeout-fn-v1] useTimeoutFn.stop() 内部等价 clearTimeout + 置空句柄
 */
function clearWatchdog(): void {
  timeoutFn.stop()
}

/**
 * 启动看门狗：WATCHDOG_MS 内未收到回复则复位 waiting
 * [WHY] 防止 transport 层消息丢失导致 waiting 永久 true，卡死后续流程
 * [CONSTRAINT] 内部先 clearWatchdog 保证同一时刻仅一个挂起定时器
 * [CHANGE-IMPACT] 手动 stopWaiting 也会 clear，避免残留 timer 触发意外复位
 */
function armWatchdog(): void {
  // [use-timeout-fn-v1] 重入安全：先 stop 再 start，等价原 clearTimeout + setTimeout
  timeoutFn.stop()
  timeoutFn.start()
}

/**
 * useAiWaiting 组合式入口
 * [CONSTRAINT] loopPaused / waiting 均为模块级单例，多组件共享同一状态；
 * 返回的 startWaiting / stopWaiting 与导出的 startWaiting 语义一致（后者供非 setup 调用）
 */
export function useAiWaiting() {
  return {
    loopPaused,
    waiting,
    startWaiting() {
      waiting.value = true
      armWatchdog()
    },
    stopWaiting() {
      waiting.value = false
      clearWatchdog()
    },
  }
}
