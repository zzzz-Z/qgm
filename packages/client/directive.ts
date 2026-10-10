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

/* ============================================================================
 * v-overflow-tip —— 只在内容被裁掉时才提示
 * ========================================================================== */

interface OverflowEl extends HTMLElement {
  __ovText?: string
  __ovOnEnter?: (e: MouseEvent) => void
  __ovOnMove?: (e: MouseEvent) => void
  __ovOnLeave?: () => void
}

/**
 * 元素内容是否被水平裁掉
 * [WHY] 抽成纯函数才能被单测直接断言边界（未上屏 / 恰好相等 / 差 1px）；
 *   指令本体依赖真实布局，node 环境测不到，判据会退化成「有没有绑监听」这种不承重的形态。
 * [CONSTRAINT] clientWidth === 0 视为「未参与布局」（display:none / 未上屏）⇒ 一律不提示，
 *   否则隐藏元素会拿到 scrollWidth>0、clientWidth=0 而被判成溢出。
 * [CHANGE-IMPACT] 容差 +1px：亚像素缩放下 scrollWidth/clientWidth 常差 1，不加会让
 *   「其实没截断」的文本也弹提示。
 */
export function isOverflowing(el: { scrollWidth?: number, clientWidth?: number }): boolean {
  const cw = Number(el.clientWidth ?? 0)
  const sw = Number(el.scrollWidth ?? 0)
  return cw > 0 && sw > cw + 1
}

/**
 * 为元素注册「溢出才提示」的监听（幂等）
 * [CONSTRAINT] 与 ensureHandlers 同构：用 __ovOnEnter 作已挂载标记，避免 updated 反复 addEventListener。
 */
function ensureOverflowHandlers(el: OverflowEl) {
  if (el.__ovOnEnter) return
  el.__ovOnEnter = (e: MouseEvent) => {
    const text = el.__ovText || ''
    // [overflow-tip-v1] 判定放在悬停**当下**现算：面板宽度会被侧栏拖拽 / 窗口缩放改变，
    //   若在 mounted 时算一次并缓存结论，就会在宽度变化后给出过期判断（该弹的不弹 / 不该弹的乱弹）。
    if (!text || !isOverflowing(el)) return
    showTooltip(text, e.clientX, e.clientY)
  }
  el.__ovOnMove = (e: MouseEvent) => { moveTooltip(e.clientX, e.clientY) }
  el.__ovOnLeave = () => { hideTooltip() }
  el.addEventListener('mouseenter', el.__ovOnEnter)
  el.addEventListener('mousemove', el.__ovOnMove)
  el.addEventListener('mouseleave', el.__ovOnLeave)
  el.addEventListener('mousedown', el.__ovOnLeave)
}

/** 与 ensureOverflowHandlers 严格配对；未调用会残留监听 */
function detachOverflow(el: OverflowEl) {
  if (!el.__ovOnEnter) return
  el.removeEventListener('mouseenter', el.__ovOnEnter)
  el.removeEventListener('mousemove', el.__ovOnMove!)
  el.removeEventListener('mouseleave', el.__ovOnLeave!)
  el.removeEventListener('mousedown', el.__ovOnLeave!)
  el.__ovOnEnter = undefined
  el.__ovOnMove = undefined
  el.__ovOnLeave = undefined
}

/**
 * 溢出才提示的 tooltip
 * [WHY] desc / why 是 `white-space:nowrap + ellipsis` 的单行文本，被裁断后用户没有任何途径看到全文；
 *   而现成的 v-tooltip 是**无条件**弹出——未截断时弹出与可见文本逐字相同的提示，纯属噪音。
 * [CONSTRAINT] 与 vTooltip 复用同一全局 tooltip 单例（useTooltip），同一时刻全应用仍只有一个提示。
 * [CHANGE-IMPACT] 不要在此处调用 syncA11yLabel：它会写 title 属性，那会让浏览器再弹一个原生
 *   tooltip，与自定义 tooltip 同时出现（双重提示）。
 */
export const vOverflowTip: Directive<OverflowEl, string | undefined> = {
  mounted(el, binding) {
    el.__ovText = String(binding.value ?? '')
    ensureOverflowHandlers(el)
  },
  updated(el, binding) {
    el.__ovText = String(binding.value ?? '')
  },
  beforeUnmount(el) {
    detachOverflow(el)
  },
}
