import { ref } from 'vue'

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
// [CONSTRAINT] 模块级 setTimeout 而非 vueuse useTimeoutFn：此文件为跨组件单例，不在 setup scope 内，
// useTimeoutFn 的 onScopeDispose 会立即清理挂起的 timer，导致 tooltip 永不显示
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

/** 取消挂起的显示/隐藏定时器；[CONSTRAINT] 必须两路都清，否则快速 hover/unhover 会残留旧 timer 交错触发 */
function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

/**
 * 请求在指针位置显示 tooltip
 * [WHY] 延迟 SHOW_DELAY 后显示，避免鼠标划过密集元素时频闪
 * [CONSTRAINT] 空 text 视为无效请求直接返回；重复调用会以最后一次坐标/文案为准（重置 timer）
 * @param text 展示文案，空串则忽略
 * @param x 屏幕像素 X（clientX）
 * @param y 屏幕像素 Y（clientY）
 */
export function showTooltip(text: string, x: number, y: number) {
  if (!text) return
  clearTimers()
  showTimer = setTimeout(() => {
    state.value = { visible: true, text, x, y }
  }, SHOW_DELAY)
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
 * [CONSTRAINT] 未显示时直接返回，避免留下挂空的 hideTimer 干扰后续 show
 */
export function hideTooltip() {
  clearTimers()
  if (!state.value.visible) return
  hideTimer = setTimeout(() => {
    state.value = { ...state.value, visible: false }
  }, HIDE_DELAY)
}

/** useTooltip 组合式入口；直接透传模块级单例，多组件共享同一 tooltip 状态 */
export function useTooltip() {
  return { state, showTooltip, moveTooltip, hideTooltip }
}
