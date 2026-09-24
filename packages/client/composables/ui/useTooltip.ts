import { ref } from 'vue'

interface TooltipState {
  visible: boolean
  text: string
  x: number
  y: number
}

/** 显示 */
const SHOW_DELAY = 300
/** 隐藏 */
const HIDE_DELAY = 80

/** 状态 */
const state = ref<TooltipState>({ visible: false, text: '', x: 0, y: 0 })
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 清空 Timers
 */
function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

/**
 * 执行 show Tooltip
 * @param text - text
 * @param x - x
 * @param y - y
 */
export function showTooltip(text: string, x: number, y: number) {
  if (!text) return
  clearTimers()
  showTimer = setTimeout(() => {
    state.value = { visible: true, text, x, y }
  }, SHOW_DELAY)
}

/**
 * 执行 move Tooltip
 * @param x - x
 * @param y - y
 */
export function moveTooltip(x: number, y: number) {
  if (state.value.visible) state.value = { ...state.value, x, y }
}

/**
 * 执行 hide Tooltip
 */
export function hideTooltip() {
  clearTimers()
  if (!state.value.visible) return
  hideTimer = setTimeout(() => {
    state.value = { ...state.value, visible: false }
  }, HIDE_DELAY)
}

/**
 * 组合式函数 Tooltip
 */
export function useTooltip() {
  return { state, showTooltip, moveTooltip, hideTooltip }
}
