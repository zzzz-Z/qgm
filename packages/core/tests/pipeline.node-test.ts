import { describe, expect, it } from 'vitest'
import {
  bumpRetry,
  canRetry,
  createPipeline,
  getCurrent,
  hasFailed,
  isComplete,
  markFailed,
  markOk,
  markRunning,
  nextRetryDelay,
  SEGMENTS,
} from '../../packages/core/src/state/pipeline'

const CFG = {
  timeouts: {},
  retries: {
    ASK_RELAY: { count: 2, backoff: [1000, 3000] },
    EXTRACT: { count: 2, backoff: [1000] },
    EXECUTE: { count: 0, backoff: [] },
  },
}

describe('pipeline: createPipeline', () => {
  it('11 段全部 pending', () => {
    const p = createPipeline()
    expect(Object.keys(p).length).toBe(SEGMENTS.length)
    for (const s of SEGMENTS) {
      expect(p[s].status).toBe('pending')
      expect(p[s].retries).toBe(0)
      expect(p[s].error).toBeNull()
    }
  })

  it('SEGMENTS 长度 11', () => {
    expect(SEGMENTS.length).toBe(11)
  })
})

describe('pipeline: 状态流转', () => {
  it('markRunning 设 running 与 startedAt', () => {
    const p = createPipeline()
    markRunning(p, 'EXECUTE', 1000)
    expect(p.EXECUTE.status).toBe('running')
    expect(p.EXECUTE.startedAt).toBe(1000)
    expect(getCurrent(p)).toBe('EXECUTE')
  })

  it('markOk 计算 durationMs', () => {
    const p = createPipeline()
    markRunning(p, 'EXECUTE', 1000)
    markOk(p, 'EXECUTE', 1500)
    expect(p.EXECUTE.status).toBe('ok')
    expect(p.EXECUTE.durationMs).toBe(500)
    expect(getCurrent(p)).toBeNull()
  })

  it('markFailed 记录错误', () => {
    const p = createPipeline()
    markRunning(p, 'EXTRACT', 100)
    markFailed(p, 'EXTRACT', 'timeout', 200)
    expect(p.EXTRACT.status).toBe('failed')
    expect(p.EXTRACT.error).toBe('timeout')
    expect(hasFailed(p)).toBe('EXTRACT')
  })

  it('未跑段 getCurrent 返回 null', () => {
    expect(getCurrent(createPipeline())).toBeNull()
  })
})

describe('pipeline: isComplete', () => {
  it('全 ok 才 true', () => {
    const p = createPipeline()
    for (const s of SEGMENTS) { markRunning(p, s, 0); markOk(p, s, 1) }
    expect(isComplete(p)).toBe(true)
  })

  it('有 pending 即 false', () => {
    const p = createPipeline()
    for (const s of SEGMENTS.slice(0, 5)) { markRunning(p, s, 0); markOk(p, s, 1) }
    expect(isComplete(p)).toBe(false)
  })
})

describe('pipeline: 重试策略', () => {
  it('未超上限可重试', () => {
    const p = createPipeline()
    expect(canRetry(p, 'ASK_RELAY', CFG)).toBe(true)
  })

  it('count=0 不可重试', () => {
    const p = createPipeline()
    expect(canRetry(p, 'EXECUTE', CFG)).toBe(false)
  })

  it('bumpRetry 到上限后不可重试', () => {
    const p = createPipeline()
    bumpRetry(p, 'ASK_RELAY')
    bumpRetry(p, 'ASK_RELAY')
    expect(canRetry(p, 'ASK_RELAY', CFG)).toBe(false)
  })

  it('nextRetryDelay 按已用次数取 backoff', () => {
    const p = createPipeline()
    expect(nextRetryDelay(p, 'ASK_RELAY', CFG)).toBe(1000)
    bumpRetry(p, 'ASK_RELAY')
    expect(nextRetryDelay(p, 'ASK_RELAY', CFG)).toBe(3000)
  })

  it('超出 backoff 长度取最后一个', () => {
    const p = createPipeline()
    bumpRetry(p, 'EXTRACT')
    bumpRetry(p, 'EXTRACT')
    bumpRetry(p, 'EXTRACT')
    expect(nextRetryDelay(p, 'EXTRACT', CFG)).toBe(1000)
  })
})
