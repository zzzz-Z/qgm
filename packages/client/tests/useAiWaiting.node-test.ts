// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useAiWaiting.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useAiWaiting.node-test.ts 迁至 test/useAiWaiting.node-test.ts
import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

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

let mod: typeof import('../composables/ai/useAiWaiting.js')
before(async () => {
  mod = await import('../composables/ai/useAiWaiting.js')
})

beforeEach(() => {
  vi.useFakeTimers()
  mod.useAiWaiting().stopWaiting()
  mod.loopPaused.value = false
})

test('导出集合：loopPaused / startWaiting / useAiWaiting', () => {
  assert.equal(typeof mod.loopPaused, 'object')
  assert.equal(typeof mod.startWaiting, 'function')
  assert.equal(typeof mod.useAiWaiting, 'function')
})

test('useAiWaiting 返回完整 API', () => {
  const r = mod.useAiWaiting()
  for (const k of ['loopPaused', 'waiting', 'startWaiting', 'stopWaiting'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('useAiWaiting 多次调用返回同一组 ref（模块单例）', () => {
  const a = mod.useAiWaiting()
  const b = mod.useAiWaiting()
  assert.equal(a.waiting, b.waiting)
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

// ── [runtime-kind-ssot-v1] 等待态与运行态唯一真相源的同步 ──
//
// [WHY] waiting 曾是和 useRuntime 并行的第二个真相源（banner 读 props、看板读 runtime）⇒ 状态显示会落后。
//   现在 waiting 只作输入框闸门，运行态一律写 useRuntime；这里钉住两向同步，防止又退化成双源。

test('[runtime-kind-ssot-v1] startWaiting → waiting；stopWaiting → idle', async () => {
  const { useRuntime } = await import('../composables/ai/useRuntime.js')
  mod.startWaiting()
  assert.equal(useRuntime().state.value.kind, 'waiting', '等待态必须同步进运行态唯一真相源')
  mod.stopWaiting()
  assert.equal(useRuntime().state.value.kind, 'idle', '回复/停止后运行态应收口为 idle')
})

test('[runtime-kind-ssot-v1] stopWaiting 不得覆盖脚本执行态', async () => {
  const { useRuntime } = await import('../composables/ai/useRuntime.js')
  const rt = useRuntime()
  mod.startWaiting()
  rt.enterExecuting()
  mod.stopWaiting()
  assert.equal(rt.state.value.kind, 'executing', '回复帧与脚本执行交错到达时不得抹掉执行态')
  rt.reset()
})
