import { effectScope, ref } from 'vue'
import { useTimeoutFn } from '@vueuse/core'

interface TooltipState {
  visible: boolean
  text: string
  x: number
  y: number
}

/** 悬停到显示之间的防抖延迟（毫秒）；[WHY] 短于 300ms 会在划过密集元素时闪烁 */
const SHOW_DELAY = 300
/** 移出到隐藏之间的延迟；[WHY] 略大于 SHOW_DELAY 的一半，允许从触发器滑到 tooltip 本体不消失 */
const HIDE_DELAY = 80

/** 全局 tooltip 单例状态；模块级共享，同一时刻全应用仅一个 tooltip 可见 */
const state = ref<TooltipState>({ visible: false, text: '', x: 0, y: 0 })

// [module-scope-vueuse-timer] vueuse 定时器需在 effectScope 内创建；本文件是跨组件单例，不在 setup scope
// [WHY] useTimeoutFn 在组件 setup 内会注册 onScopeDispose；若模块首次导入发生在某组件 setup 中，
//       该组件卸载会连带清理挂起的 timer，导致 tooltip 显示/隐藏被外部组件生命周期干扰
// [CONSTRAINT] effectScope(true) 创建 detached scope，不随任何父级卸载；scope.run 同步返回 handle
// [CHANGE-IMPACT] showFn/hideFn 每次 start 前必须 stop，保证重入安全（与旧 clearTimeout 语义等价）
const scope = effectScope(true)

/** 待显示的参数暂存：useTimeoutFn 回调无参数，需经模块级变量传递 */
let pendingShow: { text: string, x: number, y: number } | null = null

const showFn = scope.run(() => useTimeoutFn(() => {
  if (!pendingShow) return
  state.value = { visible: true, text: pendingShow.text, x: pendingShow.x, y: pendingShow.y }
  pendingShow = null
}, SHOW_DELAY, { immediate: false }))!

const hideFn = scope.run(() => useTimeoutFn(() => {
  state.value = { ...state.value, visible: false }
}, HIDE_DELAY, { immediate: false }))!

/** 取消挂起的显示/隐藏；[CONSTRAINT] 必须两路都停，否则快速 hover/unhover 会残留旧 timer 交错触发 */
function cancelTimers() {
  showFn.stop()
  hideFn.stop()
  pendingShow = null
}

/**
 * 请求在指针位置显示 tooltip
 * [WHY] 延迟 SHOW_DELAY 后显示，避免鼠标划过密集元素时频闪
 * [CONSTRAINT] 空 text 视为无效请求直接返回；重复调用以最后一次坐标/文案为准（重置 timer）
 * @param text 展示文案，空串则忽略
 * @param x 屏幕像素 X（clientX）
 * @param y 屏幕像素 Y（clientY）
 */
export function showTooltip(text: string, x: number, y: number) {
  if (!text) return
  cancelTimers()
  pendingShow = { text, x, y }
  showFn.start()
}

/**
 * 已显示的 tooltip 跟随指针移动
 * [CONSTRAINT] 仅在 visible 时更新坐标；隐藏态下移动指针不会触发显示（由 showTooltip 负责）
 */
export function moveTooltip(x: number, y: number) {
  if (state.value.visible) state.value = { ...state.value, x, y }
}

/**
 * 请求隐藏 tooltip
 * [WHY] 延迟 HIDE_DELAY 再隐藏，给用户留出从触发器滑到 tooltip 本体的容错时间
 * [CONSTRAINT] 未显示时直接返回，避免挂空的 hide timer 干扰后续 show
 */
export function hideTooltip() {
  cancelTimers()
  if (!state.value.visible) return
  hideFn.start()
}

/** useTooltip 组合式入口；直接透传模块级单例，多组件共享同一 tooltip 状态 */
export function useTooltip() {
  return { state, showTooltip, moveTooltip, hideTooltip }
}
