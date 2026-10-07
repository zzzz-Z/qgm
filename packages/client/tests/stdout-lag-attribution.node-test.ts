// [stdout-lag-attrib-v1] WO-20261007-03 段五补修验收：mock summary 帧验证跨轮滞后归因
// 判据承重：① execStart < 当前轮 sendTs ⇒ 触发告警且归属正确
//          ② execStart >= 当前轮 sendTs ⇒ 不告警
//          ③ 去掉归因分支 ⇒ ① 变红（见工单变异要求）
// [CONSTRAINT] 直接 mock readNdjson：vitest 环境下 Response.body 消费不稳（前 3 次失败已证）
import { beforeAll, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

vi.mock('../../../packages/client/utils/stream', () => ({
  readNdjson: async (_body: unknown, onFrame: (f: unknown) => void) => {
    const bag = (globalThis as unknown as { __mockFrames?: object[] }).__mockFrames || []
    for (const f of bag) onFrame(f)
  },
}))

const lsStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => { lsStore.clear() },
  key: (i: number) => Array.from(lsStore.keys())[i] ?? null,
  get length() { return lsStore.size },
} })

const ssStore = new Map<string, string>()
class StorageStub { }
Object.defineProperty(globalThis, 'Storage', { configurable: true, writable: true, value: StorageStub })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: {
  getItem: (k: string) => (ssStore.has(k) ? ssStore.get(k)! : null),
  setItem: (k: string, v: string) => { ssStore.set(k, String(v)) },
  removeItem: (k: string) => { ssStore.delete(k) },
  clear: () => { ssStore.clear() },
  key: (i: number) => Array.from(ssStore.keys())[i] ?? null,
  get length() { return ssStore.size },
} })

;(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ style: {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
}

Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  location: { href: 'http://localhost/' },
  get localStorage() { return globalThis.localStorage },
  get sessionStorage() { return globalThis.sessionStorage },
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => true,
} })

let mod: typeof import('../../../packages/client/composables/runner/useRunner')
beforeAll(async () => {
  mod = await import('../../../packages/client/composables/runner/useRunner')
})

const PROBE_SCRIPT = '// @desc probe\n// @why test\n;(async()=>{ __AI__.ok(1) })()'

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
  mod.sendTimestamps.value = []
  ;(globalThis as unknown as { __mockFrames?: object[] }).__mockFrames = []
  const r = mod.useRunner()
  r.script.value = PROBE_SCRIPT
  r.result.value = null
  r.running.value = false
})

test('[段五] execStart < 当前轮 sendTs ⇒ 触发滞后归因告警', async () => {
  const r = mod.useRunner()
  mod.sendTimestamps.value = [1000]
  ;(globalThis as unknown as { __mockFrames?: object[] }).__mockFrames = [
    { type: 'summary', runId: '2000-abc', code: 0, ok: true, changes: [] },
  ]
  globalThis.fetch = (async () => new Response('x', { status: 200 })) as typeof fetch
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ret = await r.run()
  const msgs = spy.mock.calls.map(c => String(c[0]))
  spy.mockRestore()
  assert.notEqual(ret, 'skipped', 'run 不应被 skipped 吞掉（script.value 已设）')
  assert.equal(mod.sendTimestamps.value.length, 2, '本轮应 append 一次 _sendTs')
  const hit = msgs.find(m => m.includes('滞后归因'))
  assert.ok(hit, `应触发滞后归因告警；实际 warn：${JSON.stringify(msgs)}`)
  assert.ok(String(hit).includes('第 0 轮'), `应归属第 0 轮；实际：${String(hit)}`)
})

test('[段五] execStart >= 当前轮 sendTs ⇒ 不告警', async () => {
  const r = mod.useRunner()
  mod.sendTimestamps.value = [1000]
  const futureTs = Date.now() + 100_000
  ;(globalThis as unknown as { __mockFrames?: object[] }).__mockFrames = [
    { type: 'summary', runId: `${futureTs}-xyz`, code: 0, ok: true, changes: [] },
  ]
  globalThis.fetch = (async () => new Response('x', { status: 200 })) as typeof fetch
  const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const ret = await r.run()
  const msgs = spy.mock.calls.map(c => String(c[0]))
  spy.mockRestore()
  assert.notEqual(ret, 'skipped', 'run 不应被 skipped 吞掉')
  assert.equal(mod.sendTimestamps.value.length, 2, '本轮应 append 一次 _sendTs')
  const hit = msgs.find(m => m.includes('滞后归因'))
  assert.ok(!hit, `不应触发滞后归因告警；实际：${String(hit)}`)
})
