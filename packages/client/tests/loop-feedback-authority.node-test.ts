// [loop-feedback-authority-v1] R1-R4 守卫测试
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { beforeAll, beforeEach, test } from 'vitest'
import { fileURLToPath } from 'node:url'

// ===== G3/G4 功能断言（mock 照抄 useRunner.node-test.ts）=====

const _require = createRequire(import.meta.url)
const _fs = _require('node:fs')
const _path = _require('node:path')
const here = _path.dirname(fileURLToPath(import.meta.url))
const ROOT = _path.resolve(here, '..', '..', '..')

const EXEC_FLOW_SRC = 'packages/client/components/script/exec-flow.ts'
function readSrc(rel: string): string { return _fs.readFileSync(_path.join(ROOT, rel), 'utf8') }

test('G2[P2]: exec-flow 回传成功后 softPause（isLoopActive 守卫已随循环收敛摘除）', () => {
  const src = readSrc(EXEC_FLOW_SRC)
  // [loop-consolidation-P2] isLoopActive 恒 false（auto-loop 零调用点）⇒ 原「循环活动时不暂停」的守卫
  //   已无意义，随 P2 一并摘除。留存路径下：发送成功即暂停（非循环路径恒可暂停）。
  // [VARIANT] 把 `if (r !== 'failed') softPause()` 改回无条件 softPause() ⇒ 本断言仍应通过
  //   （两者在恒可暂停语义下等价）；但删掉 softPause() ⇒ 应变红。
  assert.ok(
    src.includes('if (r !== \'failed\') softPause()'),
    'exec-flow 回传成功后未 softPause（非循环路径应能暂停等待 AI 回包）',
  )
  assert.ok(
    !src.includes('isLoopActive.value) softPause()'),
    'isLoopActive 守卫应已随 P2 摘除，不应再出现',
  )
})

const lsStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: {
  getItem: (k: string) => (lsStore.has(k) ? lsStore.get(k)! : null),
  setItem: (k: string, v: string) => { lsStore.set(k, String(v)) },
  removeItem: (k: string) => { lsStore.delete(k) },
  clear: () => lsStore.clear(),
  key: (i: number) => Array.from(lsStore.keys())[i] ?? null,
  get length() { return lsStore.size },
} })

const ssStore = new Map<string, string>()
class StorageStub {}
Object.defineProperty(globalThis, 'Storage', { configurable: true, writable: true, value: StorageStub })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, writable: true, value: {
  getItem: (k: string) => (ssStore.has(k) ? ssStore.get(k)! : null),
  setItem: (k: string, v: string) => { ssStore.set(k, String(v)) },
  removeItem: (k: string) => { ssStore.delete(k) },
  clear: () => ssStore.clear(),
  key: (i: number) => Array.from(ssStore.keys())[i] ?? null,
  get length() { return ssStore.size },
} })

Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
  createElement: () => ({ style: {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
} })
Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
  location: { href: 'http://localhost/' },
  get localStorage() { return globalThis.localStorage },
  get sessionStorage() { return globalThis.sessionStorage },
  addEventListener: () => {},
  removeEventListener: () => {},
} })

const origFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

let mod: typeof import('../composables/runner/useRunner')
beforeAll(async () => {
  mod = await import('../composables/runner/useRunner')
})

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
})

test('G3: running=true 期间调 run() 返回 skipped 标记', async () => {
  const r = mod.useRunner()
  r.running.value = true
  const res = await r.run({ script: '// @desc x\n// @why y' })
  assert.equal(res, 'skipped', 'running 期间 run 应返回 skipped（可辨识吞调用）')
  r.running.value = false
})

test('G4: run() 开始时 autoFeedbackRequested 被重置', async () => {
  const r = mod.useRunner()
  r.running.value = false
  r.autoFeedbackRequested.value = true
  const fake = { runId: 'r-probe', ok: true, code: 0 }
  globalThis.fetch = (async () => new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
  const pr = r.run({ script: '// @desc x\n// @why y' })
  assert.equal(r.autoFeedbackRequested.value, false, 'run() 开始时未重置 autoFeedbackRequested')
  await pr
  r.running.value = false
})

// [loop-consolidation-P3d] 删 G5：其断言对象 auto-loop/reply-handlers.ts 随 P3b 删除；
//   失败结果回传的守卫由留存路径的 feedback-merge 承担（见 retained-done-fixture）。
void origFetch
