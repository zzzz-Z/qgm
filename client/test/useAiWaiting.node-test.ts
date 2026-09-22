import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'

// AIRUNNER-BATCH18-1-AI-WAITING

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

const KEY = '__ai_niuma_mode'

let mod: typeof import('../composables/ai/useAiWaiting.ts')
before(async () => {
  mod = await import('../composables/ai/useAiWaiting.ts')
})

beforeEach(() => {
  // AIRUNNER-BATCH21-6-MOVE-TIMERS: 移入 hook
  vi.useFakeTimers()
  // AIRUNNER-BATCH18-1-FIX-STOP: 模块未导出 stopWaiting，改走 useAiWaiting()
  mod.useAiWaiting().stopWaiting()
  mod.niumaMode.value = false
  mod.loopPaused.value = false
  vi.useFakeTimers()
  vi.useFakeTimers()
})

test('导出集合：niumaMode / loopPaused / startWaiting / setAiWaitingWatchdog / useAiWaiting', () => {
  assert.equal(typeof mod.niumaMode, 'object')
  assert.equal(typeof mod.loopPaused, 'object')
  assert.equal(typeof mod.startWaiting, 'function')
  assert.equal(typeof mod.setAiWaitingWatchdog, 'function')
  assert.equal(typeof mod.useAiWaiting, 'function')
})

test('useAiWaiting 返回完整 API', () => {
  const r = mod.useAiWaiting()
  for (const k of ['loopPaused', 'waiting', 'niumaMode', 'fireCount', 'lastFiredAt', 'nextFireAt', 'startWaiting', 'stopWaiting'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('useAiWaiting 多次调用返回同一组 ref（模块单例）', () => {
  const a = mod.useAiWaiting()
  const b = mod.useAiWaiting()
  assert.equal(a.waiting, b.waiting)
  assert.equal(a.niumaMode, b.niumaMode)
  assert.equal(a.fireCount, b.fireCount)
})

test('loopPaused 默认 false，可独立写', () => {
  const r = mod.useAiWaiting()
  assert.equal(r.loopPaused.value, false)
  r.loopPaused.value = true
  assert.equal(mod.loopPaused.value, true)
})

test('startWaiting：设置 waiting = true', () => {
  const r = mod.useAiWaiting()
  assert.equal(r.waiting.value, false)
  mod.startWaiting()
  assert.equal(r.waiting.value, true)
})

test('startWaiting：armWatchdog 后 nextFireAt 为未来时间戳', () => {
  const r = mod.useAiWaiting()
  const t0 = Date.now()
  mod.startWaiting()
  assert.ok(r.nextFireAt.value > t0, 'nextFireAt should be in the future')
})

test('stopWaiting：清 waiting 与 watchdog', () => {
  const r = mod.useAiWaiting()
  mod.startWaiting()
  assert.equal(r.waiting.value, true)
  r.stopWaiting()
  assert.equal(r.waiting.value, false)
})

test('useAiWaiting().startWaiting 与模块级 startWaiting 等价', () => {
  const r = mod.useAiWaiting()
  r.startWaiting()
  assert.equal(r.waiting.value, true)
  r.stopWaiting()
  assert.equal(r.waiting.value, false)
})

test('niumaMode 默认 false（import 时 store 空）', () => {
  assert.equal(mod.niumaMode.value, false)
})

test('niumaMode = true 触发 watch 写 localStorage 为 1', async () => {
  mod.niumaMode.value = true
  await nextTick()
  assert.equal(store.get(KEY), '1')
})

test('niumaMode = false 触发 watch 写 localStorage 为 0', async () => {
  mod.niumaMode.value = true
  await nextTick()
  mod.niumaMode.value = false
  await nextTick()
  assert.equal(store.get(KEY), '0')
})

test('setAiWaitingWatchdog：注册 handler 后不立即调用', () => {
  let calls = 0
  mod.setAiWaitingWatchdog(() => { calls++ })
  assert.equal(calls, 0)
})

test('fireCount 初值 0', () => {
  const r = mod.useAiWaiting()
  assert.equal(r.fireCount.value, 0)
})

test('lastFiredAt 初值 0', () => {
  const r = mod.useAiWaiting()
  assert.equal(r.lastFiredAt.value, 0)
})
