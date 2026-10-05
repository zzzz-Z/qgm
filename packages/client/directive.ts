import type { Directive } from 'vue'
import { hideTooltip, moveTooltip, showTooltip } from './composables/ui/useTooltip' // [restore-import-v1] 早前清理误删

interface TooltipEl extends HTMLElement {
  __ttText?: string
  __ttOnEnter?: (e: MouseEvent) => void
  __ttOnMove?: (e: MouseEvent) => void
  __ttOnLeave?: () => void
}

/**
 * 为元素注册 tooltip 事件监听（幂等：已注册时直接返回）
 * [WHY] 指令可能在 updated 钩子被反复调用；用 __ttOnEnter 字段作为"已挂载"标记避免重复 addEventListener
 * [CONSTRAINT] 保留原生 addEventListener：指令作用在 el 元素而非组件 scope 上，
 * vueuse useEventListener 依赖 setup scope 自动清理，此处不适用
 * [CHANGE-IMPACT] 成对函数为 detach；新增事件须同时在 detach 中移除，否则内存泄漏
 * @param el 指令绑定的 DOM 元素（TooltipEl 类型带 __tt* 缓存字段）
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
 * 移除 tooltip 事件监听并清理 __tt* 缓存字段（幂等）
 * [CONSTRAINT] 与 ensureHandlers 严格配对：新增/删除事件监听必须同步两侧，
 * 移除后置 undefined 让下次 ensureHandlers 能重新挂载
 * [CHANGE-IMPACT] 指令的 unmounted 钩子调用此函数；未调用会残留监听导致内存泄漏
 * @param el 指令绑定的 DOM 元素
 */

/* [ui-p1b-tooltip-a11y-v1] V3 可达性：把 tooltip 文本同步为 title + aria-label，
   [WHY] 原实现只挂鼠标事件，键盘/屏幕阅读器用户完全拿不到按钮语义（图标按钮无文本）；
   [CONSTRAINT] 必须带 setAttribute 存在性判断——测试里的 MockEl 未实现 DOM 方法，
   直接调用会让既有 25 个单测抛错；
   [CONSTRAINT] 已有显式 aria-label 的按钮不覆盖（作者意图更精确）。 */
function syncA11yLabel(el: TooltipEl, text: string) {
  if (typeof el.setAttribute !== 'function') return
  if (!text) return
  if (!el.hasAttribute || !el.hasAttribute('title')) el.setAttribute('title', text)
  if (!el.hasAttribute || !el.hasAttribute('aria-label')) el.setAttribute('aria-label', text)
}

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
    syncA11yLabel(el, el.__ttText)
    ensureHandlers(el)
  },
  updated(el, binding) {
    el.__ttText = String(binding.value ?? '')
    syncA11yLabel(el, el.__ttText)
  },
  beforeUnmount(el) {
    detach(el)
  },
}
