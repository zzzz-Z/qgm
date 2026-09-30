import { useStorage } from '@vueuse/core'

/** 自动接管持久化键 */
const KEY = '__ai_auto_takeover'

// [use-storage-v1] 布尔持久化走 @vueuse useStorage；自定义 serializer 兼容历史 '1'/'0' 存储格式
/** 布尔 serializer：'1' <-> true，其余 <-> false */
const BOOL_SERIALIZER = {
  read: (v: string) => v === '1',
  write: (v: boolean) => (v ? '1' : '0'),
}

/** 启用的（模块级单例，跨组件共享） */
// [flush-sync-v1] 显式 flush:'sync'：模块级单例无组件上下文，默认 flush 行为在 vitest 下不可预测
// [WHY] 测试断言依赖 ref 变化立即写 localStorage；sync 让写入与 ref 赋值同步完成
// [CONSTRAINT] sync 对高频写入有性能影响；本键为手动开关，写入频率极低
const enabled = useStorage(KEY, false, undefined, { serializer: BOOL_SERIALIZER, flush: 'sync' })

/**
 * 组合式函数 Auto Takeover
 * [no-delay-v2] 已删除 3-10s 随机延迟执行机制：scheduleAutoRun 立即调用 fn
 * [WHY] 用户需求"回填脚本后立即执行"；为延迟服务的 ticker / timeoutFn / countdown / pendingMeta 一并移除
 * [CONSTRAINT] 保留 scheduleAutoRun / cancelAutoRun API 名以兼容调用点；cancelAutoRun 为 no-op
 * [CHANGE-IMPACT] 无 countdown / pendingMeta 出口；消费方（ScriptPanel/ScriptToolbar）已同步去引用
 */
export function useAutoTakeover() {
  return {
    enabled,
    enable() {
      enabled.value = true
    },
    disable() {
      enabled.value = false
    },
    /** 立即执行 fn；保留函数名以兼容历史调用点 */
    scheduleAutoRun(fn: () => void) {
      fn()
    },
    /** 无延迟即无待取消；保留空实现以兼容调用点 */
    cancelAutoRun() {
      // no-op
    },
  }
}
