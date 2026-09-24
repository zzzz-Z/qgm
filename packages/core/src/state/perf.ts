// @env node
// [perf-v1] PLAN 7.D7 性能监控：每段耗时基线 + 2x 慢标记 + 基线自更新

/** 性能基线：每个操作的耗时基线 */
export interface PerfBaseline {
  segment: string
  samples: number[]
  medianMs: number
  updatedAt: number
}

/** 性能数据存储：基线 + 采样记录 */
export interface PerfStore {
  version: 1
  maxSamples: number
  slowFactor: number
  baselines: Record<string, PerfBaseline>
}

/** 性能基线默认存储对象 */
export const DEFAULT_STORE: PerfStore = {
  version: 1,
  maxSamples: 20,
  slowFactor: 2,
  baselines: {},
}

/**
 * 执行 median
 * @param arr - arr
 */
function median(arr: number[]): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 创建 Store
 * @param partial - partial
 */
export function createStore(partial?: Partial<PerfStore>): PerfStore {
  return { ...DEFAULT_STORE, ...(partial || {}), baselines: { ...(partial?.baselines || {}) } }
}

/**
 * 记录 Sample
 * @param store - store
 * @param segment - segment
 * @param durationMs - duration Ms
 * @param now - now
 */
export function recordSample(store: PerfStore, segment: string, durationMs: number, now: number = Date.now()): PerfStore {
  const cur = store.baselines[segment]
  const samples = cur ? [...cur.samples, durationMs] : [durationMs]
  const capped = samples.slice(-store.maxSamples)
  store.baselines[segment] = {
    segment,
    samples: capped,
    medianMs: median(capped),
    updatedAt: now,
  }
  return store
}

/** 慢操作检测结果：操作名、当前耗时、基线倍数 */
export interface SlowCheck {
  slow: boolean
  ratio: number
  baselineMs: number
  thresholdMs: number
}

/**
 * 校验 Slow
 * @param store - store
 * @param segment - segment
 * @param durationMs - duration Ms
 */
export function checkSlow(store: PerfStore, segment: string, durationMs: number): SlowCheck {
  const b = store.baselines[segment]
  if (!b || b.samples.length < 3) {
    return { slow: false, ratio: 0, baselineMs: 0, thresholdMs: 0 }
  }
  const threshold = b.medianMs * store.slowFactor
  const ratio = b.medianMs > 0 ? durationMs / b.medianMs : 0
  return {
    slow: durationMs > threshold,
    ratio: Number(ratio.toFixed(2)),
    baselineMs: Math.round(b.medianMs),
    thresholdMs: Math.round(threshold),
  }
}

/**
 * 执行 summarize
 * @param store - store
 */
export function summarize(store: PerfStore): Array<{ segment: string, medianMs: number, samples: number }> {
  return Object.values(store.baselines)
    .map(b => ({ segment: b.segment, medianMs: Math.round(b.medianMs), samples: b.samples.length }))
    .sort((a, b) => b.medianMs - a.medianMs)
}

/**
 * 执行 serialize
 * @param store - store
 */
export function serialize(store: PerfStore): string {
  return JSON.stringify(store, null, 2)
}

/**
 * 执行 deserialize
 * @param raw - raw
 */
export function deserialize(raw: string): PerfStore {
  try {
    const j = JSON.parse(raw)
    if (!j || typeof j !== 'object') return createStore()
    return createStore({
      maxSamples: Number(j.maxSamples) || DEFAULT_STORE.maxSamples,
      slowFactor: Number(j.slowFactor) || DEFAULT_STORE.slowFactor,
      baselines: j.baselines || {},
    })
  } catch { return createStore() }
}
