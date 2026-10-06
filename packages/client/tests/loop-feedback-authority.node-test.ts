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

const HANDLERS_SRC = 'packages/client/composables/ai/auto-loop/reply-handlers.ts'
const EXEC_FLOW_SRC = 'packages/client/components/script/exec-flow.ts'
function readSrc(rel: string): string { return _fs.readFileSync(_path.join(ROOT, rel), 'utf8') }

test('G1: 循环引擎在 executeItemInner 阶段必须 sendFill 回传结果', () => {
  const src = readSrc(HANDLERS_SRC)
  const m = src.match(/async function executeItemInner[\s\S]*?\n {2}\}/)
  assert.ok(m, '找不到 executeItemInner 函数体')
  // [round-merge-v1] 出站口为守 §4 体积 ratchet 被上收到 flushRoundOutcome（不可内联：
  //   reply-handlers.ts 冻结在 413 行）。故判据拆成两段：① 两条分支都在 executeItemInner 内交出结果；
  //   ② 唯一出站口确实调用了 transport.sendFill。两段缺一即等于「结果回传未由循环引擎承接」。
  assert.ok(m[0].includes('stageRoundOutcome(inst.id.value, cjsOutcome'), 'cjs 分支未交出结果：结果回传未由循环引擎承接')
  assert.ok(m[0].includes('stageRoundOutcome(inst.id.value, bashOutcome'), 'bash 分支未交出结果：结果回传未由循环引擎承接')
  const flush = src.match(/function flushRoundOutcome[\s\S]*?\n {2}\}/)
  assert.ok(flush, '找不到 flushRoundOutcome 出站口')
  assert.ok(flush[0].includes('transport.sendFill'), '出站口内无 sendFill：结果回传未由循环引擎承接')
})

test('G2: exec-flow 里 softPause 必须被 isLoopActive 守卫', () => {
  const src = readSrc(EXEC_FLOW_SRC)
  // [assert-fix-v1] 用精确子串匹配实际调用行，避开注释里的反引号字面量干扰
  assert.ok(
    src.includes('!isLoopActive.value) softPause()'),
    'exec-flow 里 softPause 调用未被 isLoopActive 守卫（循环活动时仍会暂停）',
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

void origFetch
