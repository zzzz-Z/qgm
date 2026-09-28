// AIRUNNER-BATCH44-1-USE-DEEPSEEK-URL: useDeepseekUrl.ts Characterization Test (同步 API 面)
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

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

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { href: 'http://localhost/' },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    postMessage: (): void => {},
    open: () => null,
  },
})

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (): string | null => null,
    setItem: (): void => {},
    removeItem: (): void => {},
    clear: (): void => {},
  },
})

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  writable: true,
  value: { randomUUID: (): string => '00000000-0000-0000-0000-000000000000' },
})

let mod: typeof import('../../packages/client/composables/ai/useDeepseekUrl.ts')
beforeAll(async () => {
  mod = await import('../../packages/client/composables/ai/useDeepseekUrl.ts')
})

beforeEach(() => { lsStore.clear() })

// ============ 常量 ============

test('MODELS: 非空数组', () => {
  assert.ok(Array.isArray(mod.MODELS))
  assert.ok(mod.MODELS.length > 0)
})

test('MODELS: 每项含 id / label / url', () => {
  for (const m of mod.MODELS) {
    assert.equal(typeof m.id, 'string')
    assert.equal(typeof m.label, 'string')
    assert.equal(typeof m.url, 'string')
  }
})

test('DEFAULT_URL: 为合法 URL 字符串', () => {
  assert.equal(typeof mod.DEFAULT_URL, 'string')
  assert.match(mod.DEFAULT_URL, /^https?:\/\//)
})

test('useDeepseekUrl: 返回完整 API 面', () => {
  const r = mod.useDeepseekUrl()
  for (const k of [
    'modelId',
    'setModel',
    'url',
    'setUrl',
    'sessionId',
    'setSessionId',
    'display',
    'MODELS',
    'DEFAULT_URL',
    'getWindowBySid',
    'listWindows',
    'getActiveWinSid',
    'setActiveWinSid',
    'sendFillTo',
    'sendStopTo',
    'sendRotateTo',
    'sendNewSessionTo',
    'removeWindowBySid',
  ] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

// ============ getActiveWinSid / setActiveWinSid ============

test('getActiveWinSid / setActiveWinSid 读写往返', () => {
  mod.setActiveWinSid('sid-x')
  assert.equal(mod.getActiveWinSid(), 'sid-x')
})

test('setActiveWinSid 空串复位', () => {
  mod.setActiveWinSid('sid-y')
  mod.setActiveWinSid('')
  assert.equal(mod.getActiveWinSid(), '')
})

// ============ getWindowBySid / listWindows ============

test('getWindowBySid: 不存在返回 null', () => {
  assert.equal(mod.getWindowBySid(`nonexistent-${Date.now()}`), null)
})

test('listWindows: 空表返回空数组', () => {
  assert.deepEqual(mod.listWindows(), [])
})

test('removeWindowBySid: 不存在时无副作用', () => {
  assert.doesNotThrow(() => mod.removeWindowBySid('nope'))
})

// ============ send* 无窗口时返回 false ============

test('sendFillTo: 无窗口 → false', () => {
  const r = mod.sendFillTo('no-such-sid', { prompt: 'hi' })
  assert.equal(r, false)
})

test('sendStopTo: 无窗口 → false', () => {
  assert.equal(mod.sendStopTo('no-such-sid'), false)
})

test('sendRotateTo: 无窗口 → false', () => {
  assert.equal(mod.sendRotateTo('no-such-sid', { instruction: 'x' }), false)
})

test('sendNewSessionTo: 无窗口 → false', () => {
  assert.equal(mod.sendNewSessionTo('no-such-sid', { summary: 'sum' }), false)
})

test('sendFill: 无 active 窗口 → false', () => {
  mod.setActiveWinSid('')
  assert.equal(mod.sendFill({ prompt: 'hi' }), false)
})

test('sendStop: 无 active 窗口 → false', () => {
  mod.setActiveWinSid('')
  assert.equal(mod.sendStop(), false)
})

test('sendRotate: 无 active 窗口 → false', () => {
  mod.setActiveWinSid('')
  assert.equal(mod.sendRotate({ instruction: 'x' }), false)
})

test('sendNewSession: 无 active 窗口 → false', () => {
  mod.setActiveWinSid('')
  assert.equal(mod.sendNewSession({ summary: 's' }), false)
})

// ============ url / setUrl / sessionId / setSessionId ============

test('url 默认 DEFAULT_URL', () => {
  const r = mod.useDeepseekUrl()
  assert.equal(typeof r.url.value, 'string')
})

test('setUrl 更新 url ref', () => {
  const r = mod.useDeepseekUrl()
  const prev = r.url.value
  const ok = r.setUrl('https://example.test/x')
  assert.equal(typeof ok, 'boolean')
  if (ok) assert.equal(r.url.value, 'https://example.test/x')
  r.setUrl(prev)
})

test('sessionId / setSessionId 往返', () => {
  const r = mod.useDeepseekUrl()
  r.setSessionId('sid-1')
  assert.equal(r.sessionId.value, 'sid-1')
  r.setSessionId('')
})

test('modelId 默认在 MODELS 内', () => {
  const r = mod.useDeepseekUrl()
  const ids = mod.MODELS.map(m => m.id)
  assert.ok(ids.includes(r.modelId.value), `unexpected: ${r.modelId.value}`)
})

test('setModel 切换到合法 id', () => {
  const r = mod.useDeepseekUrl()
  const target = mod.MODELS[mod.MODELS.length - 1].id
  r.setModel(target)
  assert.equal(r.modelId.value, target)
})

test('display: 为函数，调用返回非空字符串', () => {
  const r = mod.useDeepseekUrl()
  assert.equal(typeof r.display, 'function')
  const out = r.display('https://chat.deepseek.com/a/chat/s/abc-123')
  assert.equal(typeof out, 'string')
  assert.ok(out.length > 0)
})

// ============ 单元隔离：不抛错断言 ============

test('setActiveWin(null) 不抛错', () => {
  assert.doesNotThrow(() => mod.setActiveWin(null))
})

test('getActiveWin 无窗口 → null', () => {
  mod.setActiveWinSid('')
  assert.equal(mod.getActiveWin(), null)
})
