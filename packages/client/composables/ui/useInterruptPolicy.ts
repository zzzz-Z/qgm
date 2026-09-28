// [tier1c-2] 打断礼仪：token bucket 预算 + 静音时段（不改决策流程，仅提供信号）
import { computed, ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** 打断策略：配额、窗口、静默判定 */
export interface InterruptPolicy {
  /** 每 windowMs 内最多 maxPerWindow 次打断 */
  windowMs: number
  maxPerWindow: number
  /** 静音时段（24h 制，分钟精度）：[startMin, endMin)；跨零点时 startMin > endMin；null 表示不启用 */
  quietStartMin: number | null
  quietEndMin: number | null
  enabled: boolean
}

/** localStorage 存储键；[CONSTRAINT] 改名会导致老用户策略重置 */
const STORAGE_KEY = 'airunner:interrupt-policy'

/** 默认策略；windowMs=10min 限 3 次，不设静音时段，默认启用 */
const DEFAULT_POLICY: InterruptPolicy = {
  windowMs: 10 * 60 * 1000,
  maxPerWindow: 3,
  quietStartMin: null,
  quietEndMin: null,
  enabled: true,
}

/**
 * 反序列化并做 schema 归一化
 * [WHY] useLocalStorage 内置 mergeDefaults 仅补 undefined，无法拦截 windowMs<=0 / maxPerWindow<0 / enabled 非布尔等脏数据
 * [CONSTRAINT] 必须与 InterruptPolicy 字段一一对应；新增字段需同步补默认分支，否则旧用户数据会缺字段
 * [CHANGE-IMPACT] 修改此函数需回归 useInterruptPolicy 相关单测；写入路径由 useLocalStorage 自动 JSON.stringify，无需对称改
 */
function normalizePolicy(raw: string | null | undefined): InterruptPolicy {
  if (!raw) return { ...DEFAULT_POLICY }
  try {
    const j = JSON.parse(raw) as Partial<InterruptPolicy>
    return {
      windowMs: Number(j.windowMs) > 0 ? Number(j.windowMs) : DEFAULT_POLICY.windowMs,
      maxPerWindow: Number(j.maxPerWindow) >= 0 ? Number(j.maxPerWindow) : DEFAULT_POLICY.maxPerWindow,
      quietStartMin: j.quietStartMin == null ? null : Number(j.quietStartMin),
      quietEndMin: j.quietEndMin == null ? null : Number(j.quietEndMin),
      enabled: j.enabled !== false,
    }
  } catch { return { ...DEFAULT_POLICY } }
}

/**
 * 判断 now 是否落在策略的静音时段内
 * [CONSTRAINT] 用分钟精度比较，忽略秒；跨零点时（start>end）取"或"关系
 */
function isInQuietHours(p: InterruptPolicy, now: Date): boolean {
  if (p.quietStartMin === null || p.quietEndMin === null) return false
  const m = now.getHours() * 60 + now.getMinutes()
  const s = p.quietStartMin
  const e = p.quietEndMin
  if (s === e) return false
  if (s < e) return m >= s && m < e
  // 跨零点：22:00 - 07:00 这类，命中 m >= s 或 m < e
  return m >= s || m < e
}

/**
 * 打断策略组合式函数（token bucket + 静音时段）
 * [WHY] 原手写 loadPolicy / savePolicy + deep watch 三件套与 vueuse useLocalStorage 完全等价，改用库实现
 * [CONSTRAINT] policy 是 module-level 单例语义的响应式对象，多组件调用共享同一份持久化数据
 * [CHANGE-IMPACT] 返回值的 history 是运行期内存态，不持久化；刷新页面后 usedInWindow 归零是预期行为
 */
export function useInterruptPolicy() {
  /** [WHY] serializer.read 走 normalizePolicy，保持与旧版 schema 校验完全一致 */
  const policy = useLocalStorage<InterruptPolicy>(STORAGE_KEY, { ...DEFAULT_POLICY }, {
    serializer: {
      read: normalizePolicy,
      write: v => JSON.stringify(v),
    },
  })

  /** 最近打断时间戳（毫秒）序列；仅内存，不持久化 */
  const history = ref<number[]>([])

  /** 丢弃落在当前窗口外的历史记录；[CONSTRAINT] 依赖 policy.value.windowMs，策略变更后需重新调用 */
  function pruneHistory(now: number): void {
    const cutoff = now - policy.value.windowMs
    history.value = history.value.filter(t => t >= cutoff)
  }

  /** [CONSTRAINT] 依赖 Date.now()，Vue 不在渲染周期外重算；短时高频读取请自行取 now 比对 */
  const usedInWindow = computed(() => {
    const now = Date.now()
    const cutoff = now - policy.value.windowMs
    return history.value.filter(t => t >= cutoff).length
  })

  const remaining = computed(() => Math.max(0, policy.value.maxPerWindow - usedInWindow.value))

  const quietNow = computed(() => isInQuietHours(policy.value, new Date()))

  /** 是否允许此刻打断：enabled 且不在静音时段 且 预算未耗尽 */
  const allowed = computed(() => policy.value.enabled && !quietNow.value && remaining.value > 0)

  /** 记录一次打断；[CONSTRAINT] 应在实际发出打断前调用，否则并发场景会超发 */
  function noteInterrupt(): void {
    const now = Date.now()
    pruneHistory(now)
    history.value = history.value.concat(now)
  }

  /** 清空内存历史（不影响持久化的 policy）；用于测试或用户手动重置窗口 */
  function reset(): void {
    history.value = []
  }

  /** 局部更新策略；[CHANGE-IMPACT] useLocalStorage 的 watch 会自动落盘，无需手动 save */
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
