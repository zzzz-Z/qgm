#!/usr/bin/env node
// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/autoLoopPersist.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/autoLoopPersist.node-test.ts 迁至 test/autoLoopPersist.node-test.ts
// @desc Characterization Test for auto-loop/persist.ts（persist + restore）
// @why 锁定抽取后行为：idle 清 key；活动态刷新后降级 stopped 且写提示；非活动态不触碰实例

import { test } from 'vitest'
import assert from 'node:assert/strict'
import type { LoopInstance } from '../../client/composables/ai/auto-loop/types.ts'
import { persist, restore } from '../../client/composables/ai/auto-loop/persist.ts'

const STORAGE_KEY = '__ai_runner_loop'

// ---- sessionStorage mock（node 无此全局） ----
const store = new Map<string, string>()
;(globalThis as unknown as { sessionStorage: unknown }).sessionStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size },
}

interface MockInst {
  id: { value: string }
  goal: { value: string }
  round: { value: number }
  startCommit: { value: string }
  startTokens: { value: number }
  stopReason: { value: string }
  state: { value: string }
}

function makeInst(overrides: Partial<MockInst> = {}): LoopInstance {
  const base: MockInst = {
    id: { value: 'loop-1' },
    goal: { value: 'goal-x' },
    round: { value: 3 },
    startCommit: { value: 'abc123' },
    startTokens: { value: 1000 },
    stopReason: { value: '' },
    state: { value: 'running' },
  }
  return { ...base, ...overrides } as unknown as LoopInstance
}

test('persist: state=idle 时清 sessionStorage key', () => {
  store.clear()
  store.set(STORAGE_KEY, '{"stale":1}')
  const inst = makeInst({ state: { value: 'idle' } })
  persist(inst)
  assert.equal(store.has(STORAGE_KEY), false)
})

test('persist: state≠idle 时写入 JSON 快照', () => {
  store.clear()
  const inst = makeInst()
  persist(inst)
  const raw = store.get(STORAGE_KEY)
  assert.ok(raw, 'expect persisted')
  const snap = JSON.parse(raw!)
  assert.equal(snap.loopId, 'loop-1')
  assert.equal(snap.loopGoal, 'goal-x')
  assert.equal(snap.loopRound, 3)
  assert.equal(snap.loopStartCommit, 'abc123')
  assert.equal(snap.loopStartTokens, 1000)
  assert.equal(snap.state, 'running')
})

test('restore: 空存储时不报错、不改实例', () => {
  store.clear()
  const inst = makeInst({ state: { value: 'idle' }, id: { value: 'KEEP' } })
  restore(inst)
  assert.equal(inst.state.value, 'idle')
  assert.equal(inst.id.value, 'KEEP')
})

test('restore: 活动态降级为 stopped 并写提示语', () => {
  store.clear()
  store.set(STORAGE_KEY, JSON.stringify({
    loopId: 'L9',
    loopGoal: 'G',
    loopRound: 5,
    loopStartCommit: 'c',
    loopStartTokens: 1,
    stopReason: '',
    state: 'running',
  }))
  const inst = makeInst({
    state: { value: 'idle' },
    id: { value: '' },
    round: { value: 0 },
  })
  restore(inst)
  assert.equal(inst.state.value, 'stopped')
  assert.equal(inst.id.value, 'L9')
  assert.equal(inst.goal.value, 'G')
  assert.equal(inst.round.value, 5)
  assert.match(inst.stopReason.value, /页面刷新中断/)
  assert.match(inst.stopReason.value, /已完成 5 轮/)
})

test('restore: 非活动态（stopped）不触碰实例', () => {
  store.clear()
  store.set(STORAGE_KEY, JSON.stringify({
    loopId: 'L',
    loopGoal: 'G',
    loopRound: 9,
    loopStartCommit: 'c',
    loopStartTokens: 1,
    stopReason: '',
    state: 'stopped',
  }))
  const inst = makeInst({ state: { value: 'idle' }, id: { value: 'KEEP' } })
  restore(inst)
  assert.equal(inst.id.value, 'KEEP')
  assert.equal(inst.state.value, 'idle')
})

test('restore: 损坏 JSON 静默忽略', () => {
  store.clear()
  store.set(STORAGE_KEY, '{not-json')
  const inst = makeInst({ state: { value: 'idle' } })
  restore(inst)
  assert.equal(inst.state.value, 'idle')
})

test('restore→persist: 降级后立即回写为 stopped 快照', () => {
  store.clear()
  store.set(STORAGE_KEY, JSON.stringify({
    loopId: 'L',
    loopGoal: 'G',
    loopRound: 2,
    loopStartCommit: 'c',
    loopStartTokens: 1,
    stopReason: '',
    state: 'running',
  }))
  const inst = makeInst({ state: { value: 'idle' } })
  restore(inst)
  const raw = store.get(STORAGE_KEY)!
  const snap = JSON.parse(raw)
  assert.equal(snap.state, 'stopped')
})
