import { ref } from 'vue'

export interface TooltipState {
  visible: boolean
  text: string
  x: number
  y: number
}

const SHOW_DELAY = 300
const HIDE_DELAY = 80

const state = ref<TooltipState>({ visible: false, text: '', x: 0, y: 0 })
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

function clearTimers() {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
}

export function showTooltip(text: string, x: number, y: number) {
  if (!text) return
  clearTimers()
  showTimer = setTimeout(() => {
    state.value = { visible: true, text, x, y }
  }, SHOW_DELAY)
}

export function moveTooltip(x: number, y: number) {
  if (state.value.visible) state.value = { ...state.value, x, y }
}

export function hideTooltip() {
  clearTimers()
  if (!state.value.visible) return
  hideTimer = setTimeout(() => {
    state.value = { ...state.value, visible: false }
  }, HIDE_DELAY)
}

export function useTooltip() {
  return { state, showTooltip, moveTooltip, hideTooltip }
}
