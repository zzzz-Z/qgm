import { describe, expect, it } from 'vitest'
import {
  checkSlow,
  createStore,
  deserialize,
  recordSample,
  serialize,
  summarize,
} from '../../packages/core/src/state/perf'

describe('perf: createStore', () => {
  it('默认 maxSamples=20 slowFactor=2', () => {
    const s = createStore()
    expect(s.maxSamples).toBe(20)
    expect(s.slowFactor).toBe(2)
    expect(s.baselines).toEqual({})
  })
})

describe('perf: recordSample', () => {
  it('首次采样建立基线', () => {
    const s = createStore()
    recordSample(s, 'EXECUTE', 100, 1000)
    expect(s.baselines.EXECUTE.samples).toEqual([100])
    expect(s.baselines.EXECUTE.medianMs).toBe(100)
    expect(s.baselines.EXECUTE.updatedAt).toBe(1000)
  })

  it('中位数计算（奇数）', () => {
    const s = createStore()
    recordSample(s, 'X', 100)
    recordSample(s, 'X', 300)
    recordSample(s, 'X', 200)
    expect(s.baselines.X.medianMs).toBe(200)
  })

  it('中位数计算（偶数）', () => {
    const s = createStore()
    recordSample(s, 'X', 100)
    recordSample(s, 'X', 300)
    expect(s.baselines.X.medianMs).toBe(200)
  })

  it('超过 maxSamples 保留最近', () => {
    const s = createStore({ maxSamples: 3 })
    recordSample(s, 'X', 1)
    recordSample(s, 'X', 2)
    recordSample(s, 'X', 3)
    recordSample(s, 'X', 4)
    expect(s.baselines.X.samples).toEqual([2, 3, 4])
  })
})

describe('perf: checkSlow', () => {
  it('样本 <3 不判慢', () => {
    const s = createStore()
    recordSample(s, 'X', 100)
    expect(checkSlow(s, 'X', 99999).slow).toBe(false)
  })

  it('超 2x 判慢', () => {
    const s = createStore()
    recordSample(s, 'X', 100)
    recordSample(s, 'X', 100)
    recordSample(s, 'X', 100)
    const r = checkSlow(s, 'X', 300)
    expect(r.slow).toBe(true)
    expect(r.ratio).toBe(3)
  })

  it('未超阈不判慢', () => {
    const s = createStore()
    recordSample(s, 'X', 100)
    recordSample(s, 'X', 100)
    recordSample(s, 'X', 100)
    expect(checkSlow(s, 'X', 150).slow).toBe(false)
  })

  it('无基线返回 slow=false', () => {
    const s = createStore()
    expect(checkSlow(s, 'NONE', 1000).slow).toBe(false)
  })
})

describe('perf: summarize / serialize', () => {
  it('summarize 按中位数降序', () => {
    const s = createStore()
    recordSample(s, 'A', 100)
    recordSample(s, 'B', 300)
    const out = summarize(s)
    expect(out[0].segment).toBe('B')
    expect(out[1].segment).toBe('A')
  })

  it('serialize→deserialize 往返', () => {
    const s = createStore()
    recordSample(s, 'X', 100)
    const round = deserialize(serialize(s))
    expect(round.baselines.X.medianMs).toBe(100)
  })

  it('deserialize 非法输入返回空 store', () => {
    const r = deserialize('not json')
    expect(r.baselines).toEqual({})
  })
})
