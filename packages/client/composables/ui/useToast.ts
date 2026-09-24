import { ref } from 'vue'

type ToastType = 'info' | 'success' | 'warn' | 'error'

interface ToastItem {
  id: number
  /**
   * 稳定 key：相同 key 的 toast 不新增，原地更新内容并续期计时器
   *  用于流式输出期间频繁触发的提示（如 token-estimate），防 MutationObserver 风暴
   */
  key?: string
  msg: string
  type: ToastType
  icon: string
  traceId?: number
}

/** 文件树图标映射（按扩展名） */
const ICONS: Record<ToastType, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '✗',
}

/** 当前展示的提示列表 */
const toasts = ref<ToastItem[]>([])
let toastSeq = 0
/** 最多同时可见条数；超出时淘汰最旧 */
const MAX_VISIBLE = 3
/** 每条提示的自动关闭定时器 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

/**
 * 清空 Timer
 * @param id - id
 */
function clearTimer(id: number) {
  const t = timers.get(id)
  if (t) { clearTimeout(t); timers.delete(id) }
}

/**
 * 执行 evict
 */
function evict() {
  while (toasts.value.length > MAX_VISIBLE) {
    const oldest = toasts.value[0]
    if (oldest) {
      clearTimer(oldest.id)
      toasts.value.shift()
    } else { break
    }
  }
}

/**
 * 提示
 * @param msg - msg
 * @param type - type
 * @param duration - duration
 * @param opts - opts
 * @param traceId - trace Id
 */
export function toast(msg: string, type: ToastType = 'info', duration = 3200, opts: { key?: string, traceId?: number } = {}) {
  const key = opts.key
  const traceId = opts.traceId
  if (key) {
    const idx = toasts.value.findIndex(t => t.key === key)
    if (idx >= 0) {
      // 原地更新 + 续期
      const existing = toasts.value[idx]
      toasts.value[idx] = { ...existing, msg, type, icon: ICONS[type] }
      clearTimer(existing.id)
      timers.set(existing.id, setTimeout(() => {
        const i = toasts.value.findIndex(t => t.id === existing.id)
        if (i >= 0) toasts.value.splice(i, 1)
        timers.delete(existing.id)
      }, duration))
      return
    }
  }
  const id = ++toastSeq
  toasts.value.push({ id, key, msg, type, icon: ICONS[type], traceId })
  evict()
  timers.set(id, setTimeout(() => {
    const i = toasts.value.findIndex(t => t.id === id)
    if (i >= 0) toasts.value.splice(i, 1)
    timers.delete(id)
  }, duration))
}

/**
 * 执行 dismiss Toast
 * @param id - id
 */
export function dismissToast(id: number) {
  const i = toasts.value.findIndex(t => t.id === id)
  if (i >= 0) toasts.value.splice(i, 1)
  clearTimer(id)
}

interface ConfirmOptions {
  detail?: string
  okText?: string
  cancelText?: string
  type?: 'danger' | 'default'
}

interface ConfirmState {
  msg: string
  detail?: string
  okText: string
  cancelText: string
  danger: boolean
  icon: string
  resolve: (v: boolean) => void
}

/** 状态 */
const confirmState = ref<ConfirmState | null>(null)

/**
 * 执行 confirm Dialog
 * @param msg - msg
 * @param opts - opts
 */
export function confirmDialog(msg: string, opts: ConfirmOptions = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (confirmState.value) {
      confirmState.value.resolve(false)
    }
    confirmState.value = {
      msg,
      detail: opts.detail,
      okText: opts.okText || '确认',
      cancelText: opts.cancelText || '取消',
      danger: opts.type === 'danger',
      icon: opts.type === 'danger' ? '!' : '?',
      resolve,
    }
  })
}

/**
 * 解析为 Confirm
 * @param v - v
 */
export function resolveConfirm(v: boolean) {
  if (!confirmState.value) return
  confirmState.value.resolve(v)
  confirmState.value = null
}

/**
 * 组合式函数 Toast
 */
export function useToast() {
  return { toasts, confirmState, toast, dismissToast, confirmDialog, resolveConfirm }
}
