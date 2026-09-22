// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useAutoTakeover.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useAutoTakeover.node-test.ts 迁至 test/useAutoTakeover.node-test.ts
import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH18-2-AUTO-TAKEOVER

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

const KEY = '__ai_auto_takeover'

let useAutoTakeover: typeof import('../../client/composables/ai/useAutoTakeover.ts').useAutoTakeover
before(async () => {
  const mod = await import('../../client/composables/ai/useAutoTakeover.ts')
  useAutoTakeover = mod.useAutoTakeover
})

beforeEach(() => {
  // AIRUNNER-BATCH21-6-MOVE-TIMERS: 移入 hook
  vi.useFakeTimers()
  const r = useAutoTakeover()
  r.cancelAutoRun()
  r.disable()
  vi.useFakeTimers()
  vi.useFakeTimers()
})

test('useAutoTakeover 返回完整 API', () => {
  const r = useAutoTakeover()
  for (const k of ['enabled', 'countdown', 'pendingMeta', 'enable', 'disable', 'scheduleAutoRun', 'cancelAutoRun'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('多次调用返回同一组 ref（模块单例）', () => {
  const a = useAutoTakeover()
  const b = useAutoTakeover()
  assert.equal(a.enabled, b.enabled)
  assert.equal(a.countdown, b.countdown)
  assert.equal(a.pendingMeta, b.pendingMeta)
})

test('初始 enabled = false（store 空）', () => {
  assert.equal(useAutoTakeover().enabled.value, false)
})

test('enable：ref 置 true 并写 localStorage = 1', () => {
  const r = useAutoTakeover()
  r.enable()
  assert.equal(r.enabled.value, true)
  assert.equal(store.get(KEY), '1')
})

test('disable：ref 置 false 并写 localStorage = 0', () => {
  const r = useAutoTakeover()
  r.enable()
  r.disable()
  assert.equal(r.enabled.value, false)
  assert.equal(store.get(KEY), '0')
})

test('disable：清 timer + ticker + countdown 归零', () => {
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => {})
  assert.ok(r.countdown.value > 0)
  r.disable()
  assert.equal(r.countdown.value, 0)
})

test('scheduleAutoRun：无 meta 时 pendingMeta 保持 null', () => {
  const r = useAutoTakeover()
  r.cancelAutoRun()
  r.scheduleAutoRun(() => {})
  assert.equal(r.pendingMeta.value, null)
})

test('scheduleAutoRun：带 meta 时 pendingMeta 被填充（缺省补空）', () => {
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => {}, { desc: 'd', lang: 'bash' })
  assert.ok(r.pendingMeta.value)
  assert.equal(r.pendingMeta.value!.desc, 'd')
  assert.equal(r.pendingMeta.value!.why, '')
  assert.equal(r.pendingMeta.value!.plan, '')
  assert.equal(r.pendingMeta.value!.lang, 'bash')
  assert.equal(r.pendingMeta.value!.lineCount, 0)
})

test('scheduleAutoRun：countdown 初值在 3-10 秒之间', () => {
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => {})
  assert.ok(r.countdown.value >= 3, `countdown=${r.countdown.value}`)
  assert.ok(r.countdown.value <= 10, `countdown=${r.countdown.value}`)
})

// AIRUNNER-BATCH18-2-FIX-FLAKY: delay 范围 [3000,10000]，tick < 3000 才必然不触发
test('scheduleAutoRun：最小 delay 前不会触发 fn', () => {
  let calls = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { calls++ })
  vi.advanceTimersByTime(2999)
  assert.equal(calls, 0)
})

test('scheduleAutoRun：tick 11s 后 fn 被调用一次', () => {
  let calls = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { calls++ })
  vi.advanceTimersByTime(11000)
  assert.equal(calls, 1)
})

test('scheduleAutoRun：fn 触发后 pendingMeta 归 null', () => {
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => {}, { desc: 'x' })
  vi.advanceTimersByTime(11000)
  assert.equal(r.pendingMeta.value, null)
})

test('scheduleAutoRun：两次调用前一次被取消（fn 只触发最后一次）', () => {
  let c1 = 0
  let c2 = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { c1++ })
  vi.advanceTimersByTime(1000)
  r.scheduleAutoRun(() => { c2++ })
  vi.advanceTimersByTime(11000)
  assert.equal(c1, 0)
  assert.equal(c2, 1)
})

test('cancelAutoRun：取消后 fn 不触发', () => {
  let calls = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { calls++ })
  r.cancelAutoRun()
  vi.advanceTimersByTime(20000)
  assert.equal(calls, 0)
})

test('cancelAutoRun：countdown 归零、pendingMeta 清空', () => {
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => {}, { desc: 'x' })
  r.cancelAutoRun()
  assert.equal(r.countdown.value, 0)
  assert.equal(r.pendingMeta.value, null)
})

test('enable / disable 反复切换：ref 反映最后一次', () => {
  const r = useAutoTakeover()
  r.enable()
  r.disable()
  r.enable()
  assert.equal(r.enabled.value, true)
  r.disable()
  assert.equal(r.enabled.value, false)
})
