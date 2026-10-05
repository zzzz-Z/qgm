// [task-store-mutation-test-v1] D1 守卫：applyTaskMutation 纯函数语义
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { applyTaskMutation } from '../src/state/task-store.js'
import type { TaskState } from '../src/state/task-store.js'

function makeState(over: Partial<TaskState> = {}): TaskState {
  return {
    round: 1,
    status: 'running',
    todo: [],
    done: [],
    ...over,
  }
}

test('G1 push: todo 追加（去重）', () => {
  const cur = makeState({ todo: ['A'] })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['A', 'B', 'C'] })
  assert.deepEqual(next.todo, ['A', 'B', 'C'])
})

test('G2 complete: 原文匹配后移入 done（含 at/round）', () => {
  const cur = makeState({ todo: ['A', 'B', 'C'], round: 7 })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['B'] })
  assert.deepEqual(next.todo, ['A', 'C'])
  assert.equal(next.done.length, 1)
  assert.equal(next.done[0].item, 'B')
  assert.equal(next.done[0].round, 7)
  assert.ok(typeof next.done[0].at === 'number' && next.done[0].at > 0)
})

test('G3 complete: 文本不匹配 → todo 不动', () => {
  const cur = makeState({ todo: ['A', 'B'] })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['不存在'] })
  assert.deepEqual(next.todo, ['A', 'B'])
  assert.equal(next.done.length, 0)
})

test('D3 set: done 默认清空（不继承 cur.done）', () => {
  const cur = makeState({ todo: ['X'], done: [{ item: 'old', at: 1, round: 1 }] })
  const next = applyTaskMutation(cur, { mode: 'set', todo: ['新任务'] })
  assert.deepEqual(next.todo, ['新任务'])
  assert.deepEqual(next.done, [])
})

test('task-running-v1: start 模式设置 running', () => {
  const cur = makeState({ todo: ['任务A', '任务B'] })
  const next = applyTaskMutation(cur, { mode: 'start', start: ['任务A'] })
  assert.equal(next.running, '任务A')
})

test('task-running-v1: complete running 项时清空 running', () => {
  const cur = makeState({ todo: ['任务A', '任务B'], running: '任务A' })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['任务A'] })
  assert.equal(next.running, '')
})

test('task-running-v1: complete 其他项时保留 running', () => {
  const cur = makeState({ todo: ['任务A', '任务B'], running: '任务A' })
  const next = applyTaskMutation(cur, { mode: 'complete', complete: ['任务B'] })
  assert.equal(next.running, '任务A')
})

test('task-running-v1: push 不影响 running', () => {
  const cur = makeState({ todo: ['任务A'], running: '任务A' })
  const next = applyTaskMutation(cur, { mode: 'push', pushTodo: ['任务B'] })
  assert.equal(next.running, '任务A')
})
