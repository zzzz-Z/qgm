import { it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { register, unregister, get, list, clear } from './composables/loopRegistry.ts'

beforeEach(() => { clear() })

it('初始状态：list 为空', () => {
  assert.deepEqual(list(), [])
})

it('register 返回 entry 并写入 Map', () => {
  const e = register('loop_a', 'loop')
  assert.equal(e.sid, 'loop_a')
  assert.equal(e.kind, 'loop')
  assert.ok(e.startedAt > 0)
  assert.equal(get('loop_a')?.sid, 'loop_a')
})

it('重复 register 返回已存在 entry，不覆盖 kind/startedAt', () => {
  const a = register('loop_x', 'loop')
  const b = register('loop_x', 'takeover')
  assert.equal(a, b)
  assert.equal(b.kind, 'loop')
  assert.equal(a.startedAt, b.startedAt)
})

it('unregister 移除并返回 true', () => {
  register('loop_del', 'loop')
  assert.equal(unregister('loop_del'), true)
  assert.equal(get('loop_del'), undefined)
})

it('unregister 不存在的 sid 返回 false', () => {
  assert.equal(unregister('nope'), false)
})

it('多实例互不干扰', () => {
  register('a', 'loop')
  register('b', 'takeover')
  assert.equal(list().length, 2)
  unregister('a')
  assert.equal(list().length, 1)
  assert.equal(get('b')?.kind, 'takeover')
})

it('list 返回快照，外部修改不影响内部', () => {
  register('a', 'loop')
  const snap = list()
  snap.push({ sid: "fake", kind: "loop", startedAt: 0 })
  assert.equal(list().length, 1)
})
