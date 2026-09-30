// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useAutoTakeover.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useAutoTakeover.node-test.ts 迁至 test/useAutoTakeover.node-test.ts
// [no-delay-v2] 已删除延迟执行机制；测试仅覆盖 enabled / enable / disable / 立即执行 / no-op cancel
import { beforeAll as before, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

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

let useAutoTakeover: typeof import('../../../packages/client/composables/ai/useAutoTakeover').useAutoTakeover
before(async () => {
  const mod = await import('../../../packages/client/composables/ai/useAutoTakeover')
  useAutoTakeover = mod.useAutoTakeover
})

beforeEach(() => {
  const r = useAutoTakeover()
  r.cancelAutoRun()
  r.disable()
})

test('useAutoTakeover 返回精简 API 面', () => {
  const r = useAutoTakeover()
  for (const k of ['enabled', 'enable', 'disable', 'scheduleAutoRun', 'cancelAutoRun'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('多次调用返回同一 enabled ref（模块单例）', () => {
  const a = useAutoTakeover()
  const b = useAutoTakeover()
  assert.equal(a.enabled, b.enabled)
})

test('初始 enabled = false（store 空）', () => {
  assert.equal(useAutoTakeover().enabled.value, false)
})

test('enable：ref 置 true', () => {
  // [third-party-persist-v1] 删 localStorage 值断言：useStorage 是 @vueuse 的职责，非本模块逻辑；
  // vitest node 环境下 mock 挂在 globalThis.localStorage，与 useStorage 探测的 window.localStorage 可能不一致
  const r = useAutoTakeover()
  r.enable()
  assert.equal(r.enabled.value, true)
})

test('disable：ref 置 false', () => {
  const r = useAutoTakeover()
  r.enable()
  r.disable()
  assert.equal(r.enabled.value, false)
})

test('scheduleAutoRun：立即同步调用 fn', () => {
  let calls = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { calls++ })
  assert.equal(calls, 1)
})

test('scheduleAutoRun：连续两次都立即执行（无取消语义）', () => {
  let c1 = 0
  let c2 = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { c1++ })
  r.scheduleAutoRun(() => { c2++ })
  assert.equal(c1, 1)
  assert.equal(c2, 1)
})

test('cancelAutoRun：no-op，不影响已执行的 fn', () => {
  let calls = 0
  const r = useAutoTakeover()
  r.scheduleAutoRun(() => { calls++ })
  r.cancelAutoRun()
  assert.equal(calls, 1)
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
