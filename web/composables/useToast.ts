import { ref } from 'vue'

export type ToastType = 'info' | 'success' | 'warn' | 'error'

export interface ToastItem {
  id: number
  msg: string
  type: ToastType
  icon: string
}

const ICONS: Record<ToastType, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '✗',
}

const toasts = ref<ToastItem[]>([])
let toastSeq = 0

export function toast(msg: string, type: ToastType = 'info', duration = 3200) {
  const id = ++toastSeq
  toasts.value.push({ id, msg, type, icon: ICONS[type] })
  // 上限 8 条，快速连续触发时淘汰最旧的，防止定时器/内存无限增长
  if (toasts.value.length > 8) toasts.value.shift()
  setTimeout(() => {
    const i = toasts.value.findIndex(t => t.id === id)
    if (i >= 0) toasts.value.splice(i, 1)
  }, duration)
}

export function dismissToast(id: number) {
  const i = toasts.value.findIndex(t => t.id === id)
  if (i >= 0) toasts.value.splice(i, 1)
}

export interface ConfirmOptions {
  detail?: string
  okText?: string
  cancelText?: string
  type?: 'danger' | 'default'
}

export interface ConfirmState {
  msg: string
  detail?: string
  okText: string
  cancelText: string
  danger: boolean
  icon: string
  resolve: (v: boolean) => void
}

const confirmState = ref<ConfirmState | null>(null)

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

export function resolveConfirm(v: boolean) {
  if (!confirmState.value) return
  confirmState.value.resolve(v)
  confirmState.value = null
}

export function useToast() {
  return { toasts, confirmState, toast, dismissToast, confirmDialog, resolveConfirm }
}
