import type { Directive } from 'vue'
import { hideTooltip, moveTooltip, showTooltip } from './composables/ui/useTooltip'

interface TooltipEl extends HTMLElement {
  __ttText?: string
  __ttOnEnter?: (e: MouseEvent) => void
  __ttOnMove?: (e: MouseEvent) => void
  __ttOnLeave?: () => void
}

/**
 * 确保 Handlers
 * @param el - el
 */
function ensureHandlers(el: TooltipEl) {
  if (el.__ttOnEnter) return
  el.__ttOnEnter = (e: MouseEvent) => {
    const text = el.__ttText || ''
    if (!text) return
    showTooltip(text, e.clientX, e.clientY)
  }
  el.__ttOnMove = (e: MouseEvent) => {
    moveTooltip(e.clientX, e.clientY)
  }
  el.__ttOnLeave = () => { hideTooltip() }
  el.addEventListener('mouseenter', el.__ttOnEnter)
  el.addEventListener('mousemove', el.__ttOnMove)
  el.addEventListener('mouseleave', el.__ttOnLeave)
  el.addEventListener('mousedown', el.__ttOnLeave)
}

/**
 * 执行 detach
 * @param el - el
 */
function detach(el: TooltipEl) {
  if (!el.__ttOnEnter) return
  el.removeEventListener('mouseenter', el.__ttOnEnter)
  el.removeEventListener('mousemove', el.__ttOnMove!)
  el.removeEventListener('mouseleave', el.__ttOnLeave!)
  el.removeEventListener('mousedown', el.__ttOnLeave!)
  el.__ttOnEnter = undefined
  el.__ttOnMove = undefined
  el.__ttOnLeave = undefined
}

/** 工具提示 */
export const vTooltip: Directive<TooltipEl, string | undefined> = {
  mounted(el, binding) {
    el.__ttText = String(binding.value ?? '')
    ensureHandlers(el)
  },
  updated(el, binding) {
    el.__ttText = String(binding.value ?? '')
  },
  beforeUnmount(el) {
    detach(el)
  },
}
