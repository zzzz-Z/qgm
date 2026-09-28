// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useTraceLog.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useTraceLog.node-test.ts 迁至 test/useTraceLog.node-test.ts
import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH17-6-TRACE-LOG-FIX

const store = new Map<string, string>()
const lsMock = {
  getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string): void => { store.set(k, String(v)) },
  removeItem: (k: string): void => { store.delete(k) },
  clear: (): void => { store.clear() },
  key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
  get length(): number { return store.size },
}
// AIRUNNER-BATCH17-6-FIX-GLOBAL: 避免 leading `;` 触发 no-unexpected-multiline
const g = globalThis as Record<string, unknown>
g.localStorage = lsMock
g.window = {
  addEventListener(): void {},
  removeEventListener(): void {},
}

let useTraceLog: typeof import('../../packages/client/composables/ui/useTraceLog.ts').useTraceLog

before(async () => {
  const mod = await import('../../packages/client/composables/ui/useTraceLog.ts')
  useTraceLog = mod.useTraceLog
})

beforeEach(() => {
  // AIRUNNER-BATCH21-6-MOVE-TIMERS: 移入 hook
  vi.useFakeTimers()
  const { clearTraces } = useTraceLog()
  clearTraces()
  vi.useFakeTimers()
  vi.useFakeTimers()
})

type Kind = 'ask' | 'run' | 'script' | 'loop'
function addSimple(kind: Kind, summary: string) {
  return useTraceLog().addTrace({ kind, summary, payload: {} })
}

test('useTraceLog: 暴露 entries / addTrace / removeTrace / clearTraces / MAX_ENTRIES', () => {
  const r = useTraceLog()
  assert.equal(typeof r.addTrace, 'function')
  assert.equal(typeof r.removeTrace, 'function')
  assert.equal(typeof r.clearTraces, 'function')
  assert.equal(typeof r.MAX_ENTRIES, 'number')
  assert.ok(r.MAX_ENTRIES > 0)
})

test('多次调用返回同一组 entries（模块单例）', () => {
  const a = useTraceLog()
  const b = useTraceLog()
  assert.equal(a.entries, b.entries)
})

test('addTrace: 插入到列表头部', () => {
  const { entries } = useTraceLog()
  addSimple('run', 'first')
  addSimple('ask', 'second')
  assert.equal(entries.value.length, 2)
  assert.equal(entries.value[0].summary, 'second')
  assert.equal(entries.value[1].summary, 'first')
})

test('addTrace: 返回带 id / ts 的 entry', () => {
  const e = addSimple('run', 'x')
  assert.equal(typeof e.id, 'number')
  assert.equal(typeof e.ts, 'number')
  assert.equal(e.kind, 'run')
  assert.equal(e.summary, 'x')
})

test('addTrace: id 自增', () => {
  const a = addSimple('run', 'a')
  const b = addSimple('run', 'b')
  assert.equal(b.id, a.id + 1)
})

test('addTrace: entries 长度不超过 MAX_ENTRIES', () => {
  const { entries, MAX_ENTRIES } = useTraceLog()
  for (let i = 0; i < MAX_ENTRIES + 20; i++) addSimple('run', `e${i}`)
  assert.equal(entries.value.length, MAX_ENTRIES)
})

test('removeTrace: 按 id 移除', () => {
  const { entries, removeTrace } = useTraceLog()
  const a = addSimple('run', 'a')
  const b = addSimple('run', 'b')
  removeTrace(a.id)
  assert.equal(entries.value.length, 1)
  assert.equal(entries.value[0].id, b.id)
})

test('removeTrace: 不存在的 id 无副作用', () => {
  const { entries, removeTrace } = useTraceLog()
  addSimple('run', 'a')
  const before = entries.value.length
  removeTrace(999999)
  assert.equal(entries.value.length, before)
})

test('clearTraces: 清空 entries', () => {
  const { entries, clearTraces } = useTraceLog()
  addSimple('run', 'a')
  addSimple('run', 'b')
  clearTraces()
  assert.equal(entries.value.length, 0)
})

test('payload: files 数组超过 50 被裁到 50', () => {
  const { entries, addTrace } = useTraceLog()
  const files = Array.from({ length: 80 }, (_, i) => `f${i}`)
  addTrace({ kind: 'run', summary: 's', payload: { files } })
  const saved = entries.value[0].payload.files as string[]
  assert.equal(saved.length, 50)
})

test('payload: changes / wantChanges 同样被裁到 50', () => {
  const { entries, addTrace } = useTraceLog()
  const arr = Array.from({ length: 60 }, (_, i) => ({ path: `p${i}`, type: 'modified' }))
  addTrace({ kind: 'run', summary: 's', payload: { changes: arr, wantChanges: arr } })
  const p = entries.value[0].payload
  const ch = p.changes as Array<{ path: string, type: string }>
  const wc = p.wantChanges as Array<{ path: string, type: string }>
  assert.equal(ch.length, 50)
  assert.equal(wc.length, 50)
})

test('payload: 普通字段超 4000 字符被截断', () => {
  const { entries, addTrace } = useTraceLog()
  const big = 'x'.repeat(8000)
  addTrace({ kind: 'run', summary: 's', payload: { note: big } })
  const note = entries.value[0].payload.note as string
  assert.ok(note.length < big.length)
  assert.ok(note.includes('truncated'))
})

test('payload: 短字段不被截断', () => {
  const { entries, addTrace } = useTraceLog()
  addTrace({ kind: 'run', summary: 's', payload: { note: 'short' } })
  assert.equal(entries.value[0].payload.note, 'short')
})

test('payload: 非字符串字段原样保留', () => {
  const { entries, addTrace } = useTraceLog()
  addTrace({ kind: 'run', summary: 's', payload: { n: 42, flag: true } })
  assert.equal(entries.value[0].payload.n, 42)
  assert.equal(entries.value[0].payload.flag, true)
})
