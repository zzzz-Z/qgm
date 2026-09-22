// AIRUNNER-BATCH43-1-USE-RUNNER: useRunner.ts Characterization Test (同步 API 面 + 持久化)
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'

// ===== 全局 mock（在 import 之前）=====
const lsStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string): string | null => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string): void => { lsStore.set(k, String(v)) },
    removeItem: (k: string): void => { lsStore.delete(k) },
    clear: (): void => { lsStore.clear() },
    key: (i: number): string | null => Array.from(lsStore.keys())[i] ?? null,
    get length(): number { return lsStore.size },
  },
})

const ssStore = new Map<string, string>()
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string): string | null => (ssStore.has(k) ? ssStore.get(k)! : null),
    setItem: (k: string, v: string): void => { ssStore.set(k, String(v)) },
    removeItem: (k: string): void => { ssStore.delete(k) },
    clear: (): void => { ssStore.clear() },
    key: (i: number): string | null => Array.from(ssStore.keys())[i] ?? null,
    get length(): number { return ssStore.size },
  },
})

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { href: 'http://localhost/' },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
  },
})

// fetch mock（防止 import 期间意外发起网络请求）
const origFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

let mod: typeof import('../../client/composables/runner/useRunner.ts')
beforeAll(async () => {
  mod = await import('../../client/composables/runner/useRunner.ts')
})

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
})

// ============ API 面 ============

test('useRunner: 返回完整 API 面', () => {
  const r = mod.useRunner()
  for (const k of [
    'script',
    'lastRunCode',
    'running',
    'result',
    'changes',
    'rolling',
    'busyAll',
    'persistWarning',
    'gitCommit',
    'smokeEnabled',
    'baselineRunId',
    'liveStdout',
    'liveStderr',
    'autoFeedbackRequested',
    'clearAutoFeedback',
    'run',
    'stop',
    'rollback',
    'rollbackAll',
    'save',
  ] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('useRunner: 多次调用返回同一组 ref（模块单例）', () => {
  const a = mod.useRunner()
  const b = mod.useRunner()
  assert.equal(a.script, b.script)
  assert.equal(a.result, b.result)
  assert.equal(a.changes, b.changes)
  assert.equal(a.running, b.running)
})

// ============ 初始状态 ============

test('初始：script 为空串（sessionStorage 空）', () => {
  const r = mod.useRunner()
  assert.equal(r.script.value, '')
})

test('初始：running / busyAll / rolling', () => {
  const r = mod.useRunner()
  assert.equal(r.running.value, false)
  assert.equal(r.busyAll.value, false)
  assert.deepEqual(r.rolling.value, {})
})

test('初始：result 为 null', () => {
  const r = mod.useRunner()
  assert.equal(r.result.value, null)
})

test('初始：changes 为空数组', () => {
  const r = mod.useRunner()
  assert.deepEqual(r.changes.value, [])
})

test('初始：persistWarning 为空串', () => {
  const r = mod.useRunner()
  assert.equal(r.persistWarning.value, '')
})

test('初始：liveStdout / liveStderr 为空串', () => {
  const r = mod.useRunner()
  assert.equal(r.liveStdout.value, '')
  assert.equal(r.liveStderr.value, '')
})

test('初始：autoFeedbackRequested = false', () => {
  const r = mod.useRunner()
  assert.equal(r.autoFeedbackRequested.value, false)
})

test('初始：smokeEnabled 默认 true', () => {
  const r = mod.useRunner()
  assert.equal(r.smokeEnabled.value, true)
})

test('初始：gitCommit 默认 false', () => {
  const r = mod.useRunner()
  assert.equal(r.gitCommit.value, false)
})

test('初始：baselineRunId 为空串', () => {
  const r = mod.useRunner()
  assert.equal(r.baselineRunId.value, '')
})

// ============ clearAutoFeedback ============

test('clearAutoFeedback: 置 false', () => {
  const r = mod.useRunner()
  r.autoFeedbackRequested.value = true
  r.clearAutoFeedback()
  assert.equal(r.autoFeedbackRequested.value, false)
})

test('clearAutoFeedback: 已是 false 时无副作用', () => {
  const r = mod.useRunner()
  assert.equal(r.autoFeedbackRequested.value, false)
  assert.doesNotThrow(() => r.clearAutoFeedback())
  assert.equal(r.autoFeedbackRequested.value, false)
})

// ============ watch 持久化 ============

test('watch: script 变化后写入 sessionStorage', async () => {
  const r = mod.useRunner()
  r.script.value = 'const x = 1'
  await nextTick()
  const raw = ssStore.get('__ai_runner_script')
  assert.ok(raw, 'sessionStorage 应有 __ai_runner_script 键')
  assert.equal(JSON.parse(raw!), 'const x = 1')
})

test('watch: smokeEnabled 变化后写入 sessionStorage', async () => {
  const r = mod.useRunner()
  r.smokeEnabled.value = false
  await nextTick()
  const raw = ssStore.get('__ai_runner_smoke')
  assert.ok(raw)
  assert.equal(JSON.parse(raw!), false)
})

test('watch: gitCommit 变化后写入 sessionStorage', async () => {
  const r = mod.useRunner()
  r.gitCommit.value = true
  await nextTick()
  const raw = ssStore.get('__ai_runner_git_commit')
  assert.ok(raw)
  assert.equal(JSON.parse(raw!), true)
})

test('watch: baselineRunId 变化后写入 sessionStorage', async () => {
  const r = mod.useRunner()
  r.baselineRunId.value = 'run-abc'
  await nextTick()
  const raw = ssStore.get('__ai_runner_baseline')
  assert.ok(raw)
  assert.equal(JSON.parse(raw!), 'run-abc')
})

test('watch: 修改 script 后 persistWarning 复位为空串', async () => {
  const r = mod.useRunner()
  r.persistWarning.value = 'stale'
  r.script.value = 'new-code'
  await nextTick()
  assert.equal(r.persistWarning.value, '')
})

// ============ 函数类型 ============

test('run / stop / rollback / rollbackAll / save 均为函数', () => {
  const r = mod.useRunner()
  assert.equal(typeof r.run, 'function')
  assert.equal(typeof r.stop, 'function')
  assert.equal(typeof r.rollback, 'function')
  assert.equal(typeof r.rollbackAll, 'function')
  assert.equal(typeof r.save, 'function')
})

test('clearAutoFeedback 为函数', () => {
  const r = mod.useRunner()
  assert.equal(typeof r.clearAutoFeedback, 'function')
})

// 恢复 fetch（进程退出前）
process.on('beforeExit', () => { globalThis.fetch = origFetch })
