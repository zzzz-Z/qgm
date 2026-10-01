// @env node
// [pipeline-v1] PLAN 5.1 链路状态机：11 段 × 4 状态纯逻辑（不接线 run.ts）

/** 流水线阶段状态枚举 */
export type SegmentStatus = 'pending' | 'running' | 'ok' | 'failed'

/** 单个流水线阶段的状态：名称、开始时间、结束时间、结果 */
export interface SegmentState {
  status: SegmentStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  error?: string | null
  retries?: number
}

/** 完整流水线：阶段列表 + 当前进度 */
export type Pipeline = Record<string, SegmentState>

/** 流水线阶段名称枚举 */
export type SegmentName = typeof SEGMENTS[number]

/** 流水线配置：阶段列表与默认超时 */
export interface PipelineConfig {
  timeouts: Record<string, number>
  retries: Record<string, { count: number, backoff: number[] }>
}

/** 流水线阶段名称列表（顺序敏感） */
export const SEGMENTS = [
  'ASK_LOCAL',
  'ASK_RELAY',
  'ASK_INJECT',
  'AI_GENERATE',
  'AI_COMPLETE',
  'EXTRACT',
  'SCRIPT_VALIDATE',
  'EXECUTE',
  'COLLECT',
  'RESULT_RELAY',
  'RESULT_INJECT',
] as const

/**
 * 初始化一个全新的流水线（所有阶段 pending）
 * [CONSTRAINT] SEGMENTS 顺序敏感：getCurrent / isComplete / hasFailed 均按此顺序遍历
 * [CHANGE-IMPACT] 新增阶段必须同步补 SEGMENTS，否则状态机不会为该阶段初始化状态槽
 */
export function createPipeline(): Pipeline {
  const pipeline: Pipeline = {}
  for (const s of SEGMENTS) pipeline[s] = { status: 'pending', retries: 0, error: null }
  return pipeline
}

/**
 * 将某阶段置为 running 并记录起始时间
 * [CONSTRAINT] 会清空 error 字段，使重复运行不复用上次失败信息
 * [CHANGE-IMPACT] 变更返回 pipeline 的引用语义（当前原地改）会影响调用方是否需重新赋值
 * @param now 时间戳，默认 Date.now()；测试时可注入固定值
 */
export function markRunning(pipeline: Pipeline, segment: SegmentName, now: number = Date.now()): Pipeline {
  const cur = pipeline[segment] || { status: 'pending' as SegmentStatus }
  pipeline[segment] = { ...cur, status: 'running', startedAt: now, error: null }
  return pipeline
}

/**
 * 将某阶段置为 ok 并计算 durationMs
 * [CONSTRAINT] 若阶段未曾 running（无 startedAt），用 now 兜底使 durationMs = 0；避免 NaN
 * [CHANGE-IMPACT] durationMs 被 run.ts 用于慢阶段识别与前端展示
 * @param now 结束时间戳；测试时可注入固定值
 */
export function markOk(pipeline: Pipeline, segment: SegmentName, now: number = Date.now()): Pipeline {
  const cur = pipeline[segment] || { status: 'pending' as SegmentStatus, startedAt: now }
  const started = cur.startedAt ?? now
  pipeline[segment] = { ...cur, status: 'ok', finishedAt: now, durationMs: now - started, error: null }
  return pipeline
}

/**
 * 将某阶段置为 failed 并记录错误与耗时
 * [CONSTRAINT] error 会原样写入并落到 .ai-runner/changelog；调用方需截断超长堆栈避免污染日志
 * [CHANGE-IMPACT] hasFailed / run.ts 的失败诊断依赖此状态值
 * @param error 失败原因（建议单行化，避免换行破坏 NDJSON）
 * @param now 结束时间戳；测试时可注入固定值
 */
export function markFailed(pipeline: Pipeline, segment: SegmentName, error: string, now: number = Date.now()): Pipeline {
  const cur = pipeline[segment] || { status: 'pending' as SegmentStatus, startedAt: now }
  const started = cur.startedAt ?? now
  pipeline[segment] = { ...cur, status: 'failed', finishedAt: now, durationMs: now - started, error }
  return pipeline
}

/**
 * 返回当前处于 running 的阶段名
 * [CONSTRAINT] 按 SEGMENTS 顺序返回首个命中；无 running 阶段时返回 null
 */
export function getCurrent(pipeline: Pipeline): SegmentName | null {
  for (const s of SEGMENTS) { if (pipeline[s] && pipeline[s].status === 'running') return s
  }
  return null
}

/**
 * 判断流水线是否全部阶段 ok
 * [CONSTRAINT] 任一阶段缺失（未初始化）也视为未完成；与 createPipeline 配合使用
 */
export function isComplete(pipeline: Pipeline): boolean {
  return SEGMENTS.every(s => pipeline[s] && pipeline[s].status === 'ok')
}

/**
 * 返回首个 failed 的阶段名
 * [CONSTRAINT] 按 SEGMENTS 顺序返回；多阶段失败时只报最先者（符合"从前往后修"的直觉）
 */
export function hasFailed(pipeline: Pipeline): SegmentName | null {
  for (const s of SEGMENTS) { if (pipeline[s] && pipeline[s].status === 'failed') return s
  }
  return null
}

/**
 * 判断某阶段是否还能重试
 * [CONSTRAINT] 只依据已用次数与 cfg 上限比较，不检查当前 status；语义是"配额未耗尽"
 * [CHANGE-IMPACT] 调用方需保证已在失败分支再调用，否则会返回"可重试"误导状态机
 */
export function canRetry(pipeline: Pipeline, segment: SegmentName, cfg: PipelineConfig): boolean {
  const rule = cfg.retries[segment]
  if (!rule) return false
  const cur = pipeline[segment]
  const used = (cur && cur.retries) || 0
  return used < rule.count
}

/**
 * 计算下一次重试应等待的毫秒数
 * [CONSTRAINT] backoff 用尽时取最后一项（不无限放大）；未配置 backoff 返回 0（不等待）
 * [CHANGE-IMPACT] 由调用方配合 bumpRetry 使用，顺序颠倒会导致取到错误档位
 */
export function nextRetryDelay(pipeline: Pipeline, segment: SegmentName, cfg: PipelineConfig): number {
  const rule = cfg.retries[segment]
  if (!rule || !rule.backoff.length) return 0
  const used = (pipeline[segment] && pipeline[segment].retries) || 0
  return rule.backoff[Math.min(used, rule.backoff.length - 1)] || 0
}

/**
 * 递增某阶段的已重试次数
 * [CONSTRAINT] 应在真正触发下一次重试前调用；与 canRetry / nextRetryDelay 的 used 计数共享同一字段
 */
export function bumpRetry(pipeline: Pipeline, segment: SegmentName): Pipeline {
  const cur = pipeline[segment] || { status: 'pending' as SegmentStatus }
  pipeline[segment] = { ...cur, retries: (cur.retries || 0) + 1 }
  return pipeline
}
