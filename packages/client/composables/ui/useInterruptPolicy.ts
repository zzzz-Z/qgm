// [tier1c-2] 打断礼仪：token bucket 预算 + 静音时段（不改决策流程，仅提供信号）
import { computed, ref, watch } from 'vue'

/** 打断策略：配额、窗口、静默判定 */
export interface InterruptPolicy {
  // 每 windowMs 内最多 maxPerWindow 次打断
  windowMs: number
  maxPerWindow: number
  // 静音时段（24h 制，分钟精度）：[startMin, endMin)；跨零点时 startMin > endMin
  quietStartMin: number | null
  quietEndMin: number | null
  enabled: boolean
}

/** 存储键 */
const STORAGE_KEY = 'airunner:interrupt-policy'

/** 默认策略 */
const DEFAULT_POLICY: InterruptPolicy = {
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 3,
  quietStartMin: null,
  quietEndMin: null,
  enabled: true,
}

/**
 * 加载 Policy
 */
function loadPolicy(): InterruptPolicy {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_POLICY }
    const j = JSON.parse(raw) as Partial<InterruptPolicy>
    return {
      windowMs: Number(j.windowMs) > 0 ? Number(j.windowMs) : DEFAULT_POLICY.windowMs,
      maxPerWindow: Number(j.maxPerWindow) >= 0 ? Number(j.maxPerWindow) : DEFAULT_POLICY.maxPerWindow,
      quietStartMin: j.quietStartMin === null || j.quietStartMin === undefined ? null : Number(j.quietStartMin),
      quietEndMin: j.quietEndMin === null || j.quietEndMin === undefined ? null : Number(j.quietEndMin),
      enabled: j.enabled !== false,
    }
  } catch { return { ...DEFAULT_POLICY } }
}

/**
 * 执行 save Policy
 * @param p - p
 */
function savePolicy(p: InterruptPolicy): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
  } catch { /* ignore */ }
}

/**
 * 判断是否为 In Quiet Hours
 * @param p - p
 * @param now - now
 */
function isInQuietHours(p: InterruptPolicy, now: Date): boolean {
  if (p.quietStartMin === null || p.quietEndMin === null) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const s = p.quietStartMin
  const e = p.quietEndMin
  if (s === e) return false
  if (s < e) return m >= s && m < e
  // 跨零点
  return m >= s || m < e
}

/**
 * 组合式函数 Interrupt Policy
 */
export function useInterruptPolicy() {
  const policy = ref<InterruptPolicy>(loadPolicy())
  // 记录最近打断时间戳（毫秒）
  const history = ref<number[]>([])

  watch(policy, (v) => { savePolicy(v) }, { deep: true })

  // 清理窗口外的旧记录
  function pruneHistory(now: number): void {
    const cutoff = now - policy.value.windowMs
    history.value = history.value.filter(t => t >= cutoff)
  }

  const usedInWindow = computed(() => {
    const now = Date.now()
    const cutoff = now - policy.value.windowMs
    return history.value.filter(t => t >= cutoff).length
  })

  const remaining = computed(() => Math.max(0, policy.value.maxPerWindow - usedInWindow.value))

  const quietNow = computed(() => isInQuietHours(policy.value, new Date()))

  // 是否允许此刻打断：enabled 且不在静音时段 且 预算未耗尽
  const allowed = computed(() => policy.value.enabled && !quietNow.value && remaining.value > 0)

  // 记录一次打断（应在实际发出打断前调用）
  function noteInterrupt(): void {
    const now = Date.now()
    pruneHistory(now)
    history.value = history.value.concat(now)
  }

  /** 重置 */
  function reset(): void {
    history.value = []
  }

  function setPolicy(patch: Partial<InterruptPolicy>): void {
    policy.value = { ...policy.value, ...patch }
  }

  const reasonText = computed(() => {
    if (!policy.value.enabled) return '已禁用'
    if (quietNow.value) return '静音时段'
    if (remaining.value <= 0) return '预算已用尽'
    return '允许打断'
  })

  return { policy, history, usedInWindow, remaining, quietNow, allowed, reasonText, noteInterrupt, reset, setPolicy }
}
