// [run-queue-v1] 执行队列单测：FIFO 语义、上限拒绝、clear 三件事。
// [判据承重] 把 enqueue 的上限判断改成恒 false / dequeue 改成 pop（LIFO）⇒ 对应用例必红（变异已验证）。
import { describe, expect, test } from 'vitest'
import { createRunQueue, MAX_PENDING_RUNS } from '../composables/runner/run-queue'

describe('run-queue: FIFO 语义', () => {
  test('先入先出：dequeue 顺序与 enqueue 一致', () => {
    const q = createRunQueue()
    q.enqueue({ script: 'a' })
    q.enqueue({ script: 'b' })
    q.enqueue({ script: 'c' })
    expect(q.dequeue()?.script).toBe('a')
    expect(q.dequeue()?.script).toBe('b')
    expect(q.dequeue()?.script).toBe('c')
    expect(q.dequeue()).toBeNull()
  })

  test('空队列 dequeue 返回 null（不抛）', () => {
    const q = createRunQueue()
    expect(q.dequeue()).toBeNull()
  })

  test('size 反映当前长度', () => {
    const q = createRunQueue()
    expect(q.size()).toBe(0)
    q.enqueue({ script: 'a' })
    expect(q.size()).toBe(1)
    q.dequeue()
    expect(q.size()).toBe(0)
  })

  test('入队项携带完整字段（runKey / autoFeedback 透传）', () => {
    const q = createRunQueue()
    q.enqueue({ script: 'x', runKey: 'rk-1', autoFeedback: true })
    const it = q.dequeue()
    expect(it?.script).toBe('x')
    expect(it?.runKey).toBe('rk-1')
    expect(it?.autoFeedback).toBe(true)
  })
})

describe('run-queue: 上限', () => {
  test(`默认上限 ${MAX_PENDING_RUNS}：满后 enqueue 返回 false 且不增长`, () => {
    const q = createRunQueue()
    for (let i = 0; i < MAX_PENDING_RUNS; i++) {
      expect(q.enqueue({ script: `s${i}` })).toBe(true)
    }
    expect(q.size()).toBe(MAX_PENDING_RUNS)
    expect(q.enqueue({ script: 'overflow' }), '满队列应拒绝入队').toBe(false)
    expect(q.size()).toBe(MAX_PENDING_RUNS)
  })

  test('max 可注入：小上限立即生效', () => {
    const q = createRunQueue(2)
    expect(q.enqueue({ script: 'a' })).toBe(true)
    expect(q.enqueue({ script: 'b' })).toBe(true)
    expect(q.enqueue({ script: 'c' })).toBe(false)
    expect(q.size()).toBe(2)
  })

  test('出队后腾出空位，可再入队', () => {
    const q = createRunQueue(2)
    q.enqueue({ script: 'a' })
    q.enqueue({ script: 'b' })
    expect(q.enqueue({ script: 'c' })).toBe(false)
    q.dequeue()
    expect(q.enqueue({ script: 'c' })).toBe(true)
    expect(q.size()).toBe(2)
  })
})

describe('run-queue: clear', () => {
  test('清空队列（stop() 场景：停止后不得再执行排队项）', () => {
    const q = createRunQueue()
    q.enqueue({ script: 'a' })
    q.enqueue({ script: 'b' })
    q.clear()
    expect(q.size()).toBe(0)
    expect(q.dequeue()).toBeNull()
  })
})
