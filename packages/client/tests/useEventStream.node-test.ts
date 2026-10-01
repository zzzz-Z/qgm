// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useEventStream.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useEventStream.node-test.ts 迁至 test/useEventStream.node-test.ts
// AIRUNNER-BATCH19-2-FIX5-TEST-PATH: 测试直连 event-stream.ts（无 useAiSite 依赖）
import { beforeAll as before, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH19-2-USE-EVENT-STREAM

const store = new Map<string, string>()
const lsMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => { store.set(k, String(v)) },
  removeItem: (k: string): void => { store.delete(k) },
  clear: (): void => { store.clear() },
  key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
  get length(): number { return store.size },
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: lsMock })

const STORAGE_KEY = '__ai_event_log'

let mod: typeof import('../../../packages/client/composables/ui/event-stream')
before(async () => {
  mod = await import('../../../packages/client/composables/ui/event-stream')
})

beforeEach(() => {
  mod.clearEvents()
  mod.setPendingAskKey('')
})

test('useEventBus: 返回 events / emit / clearEvents', () => {
  const r = mod.useEventBus()
  assert.equal(typeof r.emit, 'function')
  assert.equal(typeof r.clearEvents, 'function')
  assert.equal(typeof r.events, 'object')
})

test('useEventBus: events 与模块级 events 同源（单例）', () => {
  const a = mod.useEventBus()
  const b = mod.useEventBus()
  assert.equal(a.events, b.events)
})

test('emit: 追加一条事件到 events', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'hello')
  assert.equal(events.value.length, 1)
  assert.equal(events.value[0].kind, 'run:start')
  assert.equal(events.value[0].summary, 'hello')
})

test('emit: id 单调递增', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'a')
  mod.emit('run:end', 'b')
  assert.ok(events.value[1].id > events.value[0].id)
})

test('emit: 携带 round 时写入事件', () => {
  const { events } = mod.useEventBus()
  mod.emit('loop:round', 'r1', { round: 5 })
  assert.equal(events.value[0].round, 5)
})

test('emit: 无 round 时事件不含 round 字段', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'x')
  assert.equal('round' in events.value[0], false)
})

test('emit: 携带 payload 时写入事件', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'x', { payload: { foo: 1 } })
  assert.equal(events.value[0].payload?.foo, 1)
})

test('emit: 无 payload 时事件不含 payload 字段', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'x')
  assert.equal('payload' in events.value[0], false)
})

test('emit: updateKey 首次仍新增事件', () => {
  const { events } = mod.useEventBus()
  mod.emit('ai:ask', 'q1', { updateKey: 'k1' })
  assert.equal(events.value.length, 1)
  assert.equal(events.value[0].payload?.updateKey, 'k1')
})

test('emit: updateKey 二次命中原地更新（不新增）', () => {
  const { events } = mod.useEventBus()
  mod.emit('ai:ask', 'q1', { updateKey: 'k1' })
  mod.emit('run:start', 'q2', { updateKey: 'k1' })
  assert.equal(events.value.length, 1)
  assert.equal(events.value[0].summary, 'q2')
  assert.equal(events.value[0].kind, 'ai:ask', 'kind should stay original')
})

test('emit: updateKey 原地更新保留 id', () => {
  const { events } = mod.useEventBus()
  mod.emit('ai:ask', 'a', { updateKey: 'x' })
  const id1 = events.value[0].id
  mod.emit('run:start', 'b', { updateKey: 'x' })
  assert.equal(events.value[0].id, id1)
})

test('emit: updateKey 二次合并 payload（不覆盖既有键）', () => {
  const { events } = mod.useEventBus()
  mod.emit('ai:ask', 'a', { updateKey: 'x', payload: { foo: 1, bar: 2 } })
  mod.emit('run:start', 'b', { updateKey: 'x', payload: { bar: 99, baz: 3 } })
  const p = events.value[0].payload as Record<string, unknown>
  assert.equal(p.foo, 1)
  assert.equal(p.bar, 99)
  assert.equal(p.baz, 3)
  assert.equal(p.updateKey, 'x')
})

test('emit: 不同 updateKey 独立事件', () => {
  const { events } = mod.useEventBus()
  mod.emit('ai:ask', 'a', { updateKey: 'k1' })
  mod.emit('ai:ask', 'b', { updateKey: 'k2' })
  assert.equal(events.value.length, 2)
})

test('emit: 无 updateKey 时即使 kind/summary 相同也新增', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'same')
  mod.emit('run:start', 'same')
  assert.equal(events.value.length, 2)
})

test('emit: 每次调用后写入 localStorage', () => {
  mod.emit('run:start', 'a')
  const raw = store.get(STORAGE_KEY)
  assert.ok(raw, 'localStorage should have data')
  const arr = JSON.parse(raw!)
  assert.equal(arr.length, 1)
  assert.equal(arr[0].summary, 'a')
})

test('emit: 超过 MAX_EVENTS=500 时裁剪', () => {
  const { events } = mod.useEventBus()
  for (let i = 0; i < 510; i++) mod.emit('run:start', `e${i}`)
  assert.ok(events.value.length <= 500)
})

test('clearEvents: 清空 events', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'a')
  mod.emit('run:start', 'b')
  mod.clearEvents()
  assert.equal(events.value.length, 0)
})

test('clearEvents: 移除 localStorage 键', () => {
  mod.emit('run:start', 'a')
  assert.ok(store.has(STORAGE_KEY))
  mod.clearEvents()
  assert.equal(store.has(STORAGE_KEY), false)
})

test('clearEvents: seq 归零（后续 id 从 1 起）', () => {
  const { events } = mod.useEventBus()
  mod.emit('run:start', 'a')
  mod.emit('run:start', 'b')
  mod.clearEvents()
  mod.emit('run:start', 'c')
  assert.equal(events.value[0].id, 1)
})

test('setPendingAskKey / peekPendingAskKey', () => {
  mod.setPendingAskKey('k1')
  assert.equal(mod.peekPendingAskKey(), 'k1')
})

test('takePendingAskKey: 取后清空', () => {
  mod.setPendingAskKey('k2')
  assert.equal(mod.takePendingAskKey(), 'k2')
  assert.equal(mod.peekPendingAskKey(), '')
  assert.equal(mod.takePendingAskKey(), '')
})
