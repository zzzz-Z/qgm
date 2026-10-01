import { ref } from 'vue'

type ToastType = 'info' | 'success' | 'warn' | 'error'

interface ToastItem {
  id: number
  /**
   * 稳定 key：相同 key 的 toast 不新增，原地更新内容并续期计时器
   *  用于流式输出期间频繁触发的提示（如流式高频更新），防 MutationObserver 风暴
   */
  key?: string
  msg: string
  type: ToastType
  icon: string
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

/** toast 类型 → 单字符图标；扩 ToastType 时必须同步补 key，否则渲染 undefined */
const ICONS: Record<ToastType, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '✗',
}

let toastSeq = 0
/** 最多同时可见条数；超出时淘汰最旧（见 evict） */
const MAX_VISIBLE = 3
/** 每条提示的自动关闭定时器；[CONSTRAINT] key = toast.id，随 toast 生命周期同步 set/delete，防 Map 泄漏 */
const timers = new Map<number, ReturnType<typeof setTimeout>>()

/** 当前展示的提示列表；模块级单例，多组件共享同一队列 */
const toasts = ref<ToastItem[]>([])

/** 全局确认弹窗状态；null 表示未展示，同一时刻仅一个（见 confirmDialog 的单例约定） */
const confirmState = ref<ConfirmState | null>(null)

/** 停止并移除某条 toast 的关闭定时器；[CONSTRAINT] 必须与 timers.delete 同时调用，否则旧 timer 会残留触发 */
function clearTimer(id: number) {
  const t = timers.get(id)
  if (t) { clearTimeout(t); timers.delete(id) }
}

/** 队列超限时从队头摘除；[CONSTRAINT] 依赖 toasts 保持 FIFO（push 进 / shift 出），否则淘汰的不是最旧项 */
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
 * 弹出（或按 key 原地刷新）一条提示
 * [WHY] 传 key 时复用同一 toast 并续期，避免流式高频提示刷屏
 * [CONSTRAINT] key 复用仅更新前 3 字段（msg/type/icon），id 与占位顺序不变
 * [CHANGE-IMPACT] 修改自动关闭逻辑须同步改动 armTimer 内联路径与 dismissToast 手动路径
 * @param duration 毫秒；传 0 或负数将被 setTimeout 立即调度
 * @param opts.key 稳定标识，相同 key 视为同一条
 */
export function toast(msg: string, type: ToastType = 'info', duration = 3200, opts: { key?: string } = {}) {
  const key = opts.key
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
  toasts.value.push({ id, key, msg, type, icon: ICONS[type] })
  evict()
  timers.set(id, setTimeout(() => {
    const i = toasts.value.findIndex(t => t.id === id)
    if (i >= 0) toasts.value.splice(i, 1)
    timers.delete(id)
  }, duration))
}

/** 手动关闭指定 toast；[CONSTRAINT] 幂等，id 不存在时无副作用 */
export function dismissToast(id: number) {
  const i = toasts.value.findIndex(t => t.id === id)
  if (i >= 0) toasts.value.splice(i, 1)
  clearTimer(id)
}

/**
 * 打开确认弹窗并返回用户选择
 * [CONSTRAINT] 单例：已有弹窗时会先以 false 主动 resolve 旧 Promise，避免调用方 await 挂死
 * [CHANGE-IMPACT] resolve 引用被存进 confirmState，必须由 resolveConfirm 消费后再置 null
 * @param opts.type 'danger' 时渲染警告图标与红色按钮
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

/** 关闭确认弹窗并回传用户选择；[CONSTRAINT] 与 confirmDialog 成对使用，弹窗未开时静默 */
export function resolveConfirm(confirmed: boolean) {
  if (!confirmState.value) return
  confirmState.value.resolve(confirmed)
  confirmState.value = null
}

/** useToast 组合式入口；直接透传模块级单例，多组件调用共享同一队列与弹窗状态 */
export function useToast() {
  return { toasts, confirmState, toast, dismissToast, confirmDialog, resolveConfirm }
}
