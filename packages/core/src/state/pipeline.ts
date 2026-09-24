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

/** 流水线阶段名称枚举 */
export type SegmentName = typeof SEGMENTS[number]

/** 流水线配置：阶段列表与默认超时 */
export interface PipelineConfig {
  timeouts: Record<string, number>
  retries: Record<string, { count: number, backoff: number[] }>
}

/**
 * 创建 Pipeline
 */
export function createPipeline(): Pipeline {
  const p: Pipeline = {}
  for (const s of SEGMENTS) p[s] = { status: 'pending', retries: 0, error: null }
  return p
}

/**
 * 标记 Running
 * @param p - p
 * @param seg - seg
 * @param now - now
 */
export function markRunning(p: Pipeline, seg: SegmentName, now: number = Date.now()): Pipeline {
  const cur = p[seg] || { status: 'pending' as SegmentStatus }
  p[seg] = { ...cur, status: 'running', startedAt: now, error: null }
  return p
}

/**
 * 标记 Ok
 * @param p - p
 * @param seg - seg
 * @param now - now
 */
export function markOk(p: Pipeline, seg: SegmentName, now: number = Date.now()): Pipeline {
  const cur = p[seg] || { status: 'pending' as SegmentStatus, startedAt: now }
  const started = cur.startedAt ?? now
  p[seg] = { ...cur, status: 'ok', finishedAt: now, durationMs: now - started, error: null }
  return p
}

/**
 * 标记 Failed
 * @param p - p
 * @param seg - seg
 * @param error - error
 * @param now - now
 */
export function markFailed(p: Pipeline, seg: SegmentName, error: string, now: number = Date.now()): Pipeline {
  const cur = p[seg] || { status: 'pending' as SegmentStatus, startedAt: now }
  const started = cur.startedAt ?? now
  p[seg] = { ...cur, status: 'failed', finishedAt: now, durationMs: now - started, error }
  return p
}

/**
 * 获取 Current
 * @param p - p
 */
export function getCurrent(p: Pipeline): SegmentName | null {
  for (const s of SEGMENTS) { if (p[s] && p[s].status === 'running') return s
  }
  return null
}

/**
 * 判断是否为 Complete
 * @param p - p
 */
export function isComplete(p: Pipeline): boolean {
  return SEGMENTS.every(s => p[s] && p[s].status === 'ok')
}

/**
 * 判断是否包含 Failed
 * @param p - p
 */
export function hasFailed(p: Pipeline): SegmentName | null {
  for (const s of SEGMENTS) { if (p[s] && p[s].status === 'failed') return s
  }
  return null
}

/**
 * 判断能否 Retry
 * @param p - p
 * @param seg - seg
 * @param cfg - cfg
 */
export function canRetry(p: Pipeline, seg: SegmentName, cfg: PipelineConfig): boolean {
  const rule = cfg.retries[seg]
  if (!rule) return false
  const cur = p[seg]
  const used = (cur && cur.retries) || 0
  return used < rule.count
}

/**
 * 执行 next Retry Delay
 * @param p - p
 * @param seg - seg
 * @param cfg - cfg
 */
export function nextRetryDelay(p: Pipeline, seg: SegmentName, cfg: PipelineConfig): number {
  const rule = cfg.retries[seg]
  if (!rule || !rule.backoff.length) return 0
  const used = (p[seg] && p[seg].retries) || 0
  return rule.backoff[Math.min(used, rule.backoff.length - 1)] || 0
}

/**
 * 执行 bump Retry
 * @param p - p
 * @param seg - seg
 */
export function bumpRetry(p: Pipeline, seg: SegmentName): Pipeline {
  const cur = p[seg] || { status: 'pending' as SegmentStatus }
  p[seg] = { ...cur, retries: (cur.retries || 0) + 1 }
  return p
}
