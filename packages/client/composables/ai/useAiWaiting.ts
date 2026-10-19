import { effectScope, ref } from 'vue'
import { useTimeoutFn } from '@vueuse/core'
import { useRuntime } from './useRuntime'
/** 跨组件共享的「等待 AI 回复」（单一数据源） */

// 3 分钟无回复则复位 waiting，避免永久卡死
const WATCHDOG_MS = 180_000
/** 是否处于等待 AI 回复状态；内存态，不持久化 */
const waiting = ref(false)

/**
 * [remote-generating-v1] AI 页面侧的真实生成态（由油猴 ai-runner:generating-state 帧驱动）。
 * [WHY] waiting 是「等工作台回包」的短窗口 + 看门狗超时；running 是「脚本执行中」。
 *   两者都无法表达「AI 仍在吐字」——DONE 已到但 AI 还在深度思考时，按钮会提前消失。
 * [CONSTRAINT] 只由 transport 层 setRemoteGenerating 写；组件只读。
 */
export const remoteGenerating = ref(false)
/** 设置远程生成态；由 useAiTransport 消费 generating-state / turn-end 帧时调用 */
export function setRemoteGenerating(v: boolean): void {
  remoteGenerating.value = Boolean(v)
}

// [module-scope-vueuse-timer] vueuse 定时器需在 effectScope 内创建；本模块为跨组件单例
// [WHY] useTimeoutFn 在组件 setup 内会注册 onScopeDispose；若模块首次导入发生在某组件 setup 中，
//       该组件卸载会连带清理 watchdog → 3 分钟兜底失效
// [CONSTRAINT] effectScope(true) 创建 detached scope；WATCHDOG_MS 为常量，无需动态延迟 ref
// [CHANGE-IMPACT] 原 watchdogTimer 显式句柄语义由 timeoutFn.start()/stop() 等价替代
const scope = effectScope(true)
const timeoutFn = scope.run(() => useTimeoutFn(() => {
  // [runtime-kind-ssot-v1] 超时也须走 stopWaiting：只清 waiting 会让运行态/banner 永久卡在 waiting
  stopWaiting()
}, WATCHDOG_MS, { immediate: false }))!

/**
 * 暂停闸：阻断续推 / 发脚本 / 等待
 * [loop-consolidation-P2] 从 useSessionStorage 改回内存态 ref。
 * [WHY] 原持久化会让「异常残留 true 后刷新不清」——手动消息被静默拦下（useAiTransport.ts:100 自陈）。
 *   单路径下暂停是临时态：刷新本身已中断当前会话，恢复可交互才符合预期。
 * [CONSTRAINT] 仍是模块级单例，多组件共享；接口不变（.value 读写）。
 * [CHANGE-IMPACT] 刷新后不再保持暂停态；跨标签页各自独立（原本也不跨）。
 */
export const loopPaused = ref(false)

/**
 * [loop-consolidation-P3b] 从 auto-loop/pause-control.ts 迁出：软暂停只置标志，不动状态机。
 * [WHY] script-panel-actions / ScriptPanel / exec-flow 三处留存路径都要用它；
 *   留在 auto-loop/ 会随 P3b 删除目录一起消失。
 * [CONSTRAINT] 与旧实现逐字等价（旧版还调 bindKeyboard/transport.mute，那些是循环专用，已在 P2 摘除）。
 */
export function softPause(): void {
  loopPaused.value = true
}

/**
 * [loop-consolidation-P3b] 从 auto-loop/pause-control.ts 迁出：复位残留暂停标志。
 * [WHY] ScriptPanel 二次点击发送时调用：清除第一次发送后 softPause 留下的 paused 状态。
 * [CONSTRAINT] 旧实现含 isLoopActive 守卫（恒 false）与 transport.unMute，前者已摘、后者已随循环退役。
 */
export function clearSoftPause(): void {
  loopPaused.value = false
}

/**
 * 进入等待 AI 回复状态并重置看门狗
 * [WHY] 单独 startWaiting 与 useAiWaiting 返回的同名方法并存：供 transport 层在 setup 外直接调用
 * [CHANGE-IMPACT] 内部先 timeoutFn.stop() 再 start()，重复调用等价于续期
 */
export function startWaiting(): void {
  waiting.value = true
  // [runtime-kind-ssot-v1] 等待 AI 回复是运行时的独立阶段：同步写唯一真相源
  useRuntime().enterWaiting()
  armWatchdog()
}

/**
 * 取消等待 AI 回复状态；幂等
 * [runtime-kind-ssot-v1] 同步收口 useRuntime：回复到达 / 用户停止时，只把「等待」态收回 idle；
 *   脚本执行 / 回传中的收口归执行器（回复帧可能与它们交错到达，此处不得抹掉）。
 */
export function stopWaiting(): void {
  waiting.value = false
  clearWatchdog()
  const rt = useRuntime()
  if (rt.state.value.kind === 'waiting') rt.settleIdle()
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
    softPause,
    clearSoftPause,
    waiting,
    remoteGenerating,
    setRemoteGenerating,
    // [runtime-kind-ssot-v1] 复用模块级同名函数：返回对象与导出函数语义必须一致（避免两套实现分叉）
    startWaiting,
    stopWaiting,
  }
}
