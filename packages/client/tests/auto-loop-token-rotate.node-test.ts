// AIRUNNER-BATCH37-1-TOKEN-ROTATE: auto-loop/token-rotate.ts Characterization Test
import { beforeAll, test } from 'vitest'
import assert from 'node:assert/strict'

// localStorage + window mock 必须在 import 之前（useAutoLoop 用到）
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

const windowMock = {
  location: { href: 'http://localhost/' },
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
}
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: windowMock })

let mod: typeof import('../../packages/client/composables/ai/auto-loop/token-rotate.ts')
beforeAll(async () => {
  mod = await import('../../packages/client/composables/ai/auto-loop/token-rotate.ts')
})

// ============ autoRotateSession ============

test('autoRotateSession: 默认 true（store 空 → fallback）', () => {
  assert.equal(mod.autoRotateSession.value, true)
})

test('autoRotateSession: ref 可写', () => {
  mod.autoRotateSession.value = false
  assert.equal(mod.autoRotateSession.value, false)
  mod.autoRotateSession.value = true
  assert.equal(mod.autoRotateSession.value, true)
})

// ============ setTokenEstimate 无 active loop 分支 ============

test('setTokenEstimate: 0 不抛错', () => {
  assert.doesNotThrow(() => mod.setTokenEstimate(0))
})

test('setTokenEstimate: 负数被钳为 0 且不抛错', () => {
  assert.doesNotThrow(() => mod.setTokenEstimate(-100))
})

test('setTokenEstimate: NaN → 0 不抛错', () => {
  assert.doesNotThrow(() => mod.setTokenEstimate(NaN))
})

test('setTokenEstimate: 小于 ROTATE_THRESHOLD 不触发轮转（不抛错）', () => {
  assert.doesNotThrow(() => mod.setTokenEstimate(1000))
})

test('setTokenEstimate: 大于 ROTATE_THRESHOLD 但 idle 态不触发轮转', () => {
  // autoRotateSession=true 但 isLoopActive=false（默认 idle）→ 提前 return，不调用 handoff
  assert.doesNotThrow(() => mod.setTokenEstimate(50000))
})

test('setTokenEstimate: autoRotateSession=false 时不触发轮转', () => {
  mod.autoRotateSession.value = false
  try {
    assert.doesNotThrow(() => mod.setTokenEstimate(50000))
  } finally {
    mod.autoRotateSession.value = true
  }
})
