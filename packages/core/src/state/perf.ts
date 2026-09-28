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
 * 计算数组中位数
 * [CONSTRAINT] 空数组返回 0；偶数长度取中间两项均值；不修改入参数组（先 slice 后 sort）
 * [WHY] 用中位数而非均值：单次异常慢的采样不应污染基线
 */
function median(arr: number[]): number {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * 合并默认值生成 PerfStore 实例
 * [CONSTRAINT] baselines 会展开浅拷贝，避免多实例共享同一 baselines 对象
 * @param partial 可选覆盖字段；未提供字段走 DEFAULT_STORE
 */
export function createStore(partial?: Partial<PerfStore>): PerfStore {
  return { ...DEFAULT_STORE, ...(partial || {}), baselines: { ...(partial?.baselines || {}) } }
}

/**
 * 记录一次耗时采样并重算基线中位数
 * [CONSTRAINT] 采样数超过 maxSamples 时丢弃最旧项（FIFO），保证基线随近期表现自适应
 * [CHANGE-IMPACT] 就地修改 store.baselines；多调用方共享同一 store 时不要并发调用
 * @param store 就地修改的目标存储
 * @param segment 操作名（如 'EXECUTE'）
 * @param durationMs 本次采样耗时（毫秒）
 * @param now 时间戳，默认 Date.now()；测试可注入
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
 * 判断本次耗时是否相对基线显著变慢
 * [CONSTRAINT] 基线采样 < 3 时不判定（样本不足）；基线中位数为 0 时 ratio 置 0 而非除零
 * [CHANGE-IMPACT] slowFactor 决定敏感度，误调会引发大量误报
 * @param durationMs 待判定的耗时
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
 * 汇总所有基线为可展示列表（按中位耗时降序）
 * [WHY] 供 UI / 报告展示最慢操作；降序排列让异常段自然置顶
 * [CONSTRAINT] 只返回汇总字段，不含原始 samples 数组，减小传输体积
 */
export function summarize(store: PerfStore): Array<{ segment: string, medianMs: number, samples: number }> {
  return Object.values(store.baselines)
    .map(b => ({ segment: b.segment, medianMs: Math.round(b.medianMs), samples: b.samples.length }))
    .sort((a, b) => b.medianMs - a.medianMs)
}

/**
 * 序列化 PerfStore 为 JSON 字符串（带 2 空格缩进，便于人工查看）
 * [CONSTRAINT] 与 deserialize 严格配对；写入 .ai-runner/perf.json 时两侧格式必须一致
 */
export function serialize(store: PerfStore): string {
  return JSON.stringify(store, null, 2)
}

/**
 * 从 JSON 字符串解析 PerfStore
 * [WHY] 容错优先：解析失败或字段缺失一律回落默认值，避免性能数据损坏导致主流程崩溃
 * [CONSTRAINT] maxSamples / slowFactor 用 Number 强转 + || 兜底；0 会走默认（视为无效配置）
 * @param raw perf.json 的文本内容；空串或非法 JSON 均返回默认 store
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
