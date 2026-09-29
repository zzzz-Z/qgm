// AIRUNNER-BATCH40-1-SESSION-MANAGER: useSessionManager.ts Characterization Test
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

// ===== 全局 mock（必须在 import 之前）=====
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

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    clipboard: { writeText: async (): Promise<void> => {} },
  },
})

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  writable: true,
  value: { randomUUID: (): string => '00000000-0000-0000-0000-000000000000' },
})

let mod: typeof import('../composables/ai/useSessionManager.ts')
beforeAll(async () => {
  mod = await import('../composables/ai/useSessionManager.ts')
})

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
  const r = mod.useSessionManager()
  r.resetSession()
  r.resetAskCount()
  r.messages.value = []
})

// ============ 常量 ============

test('WARN_THRESHOLD = 40000', () => {
  assert.equal(mod.WARN_THRESHOLD, 40000)
})

test('HARD_LIMIT = 50000', () => {
  assert.equal(mod.HARD_LIMIT, 50000)
})

test('ASK_ROTATE_THRESHOLD = 200', () => {
  assert.equal(mod.ASK_ROTATE_THRESHOLD, 200)
})

test('WARN_THRESHOLD < HARD_LIMIT', () => {
  assert.ok(mod.WARN_THRESHOLD < mod.HARD_LIMIT)
})

// ============ API 面 ============

test('useSessionManager: 返回完整 API 面', () => {
  const r = mod.useSessionManager()
  for (const k of [
    'sessionId',
    'sessionUrl',
    'messages',
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'usagePercent',
    'isApproachingLimit',
    'isOverLimit',
    'WARN_THRESHOLD',
    'HARD_LIMIT',
    'trackMessage',
    'maybeRotateSession',
    'askCount',
    'resetAskCount',
    'copyAndHandoff',
    'resetSession',
    'restoreFromStorage',
    'generateHandoffSummary',
    'updateSessionUrl',
  ] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('useSessionManager: 多次调用返回同一组 ref（模块单例）', () => {
  const a = mod.useSessionManager()
  const b = mod.useSessionManager()
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(a.messages, b.messages)
  assert.equal(a.askCount, b.askCount)
})

// ============ 初始状态 ============

test('初始：sessionId 非空', () => {
  const r = mod.useSessionManager()
  assert.equal(typeof r.sessionId.value, 'string')
  assert.ok(r.sessionId.value.length > 0)
})

test('初始：sessionUrl 为 window.location.href', () => {
  const r = mod.useSessionManager()
  assert.equal(r.sessionUrl.value, 'http://localhost/')
})

test('初始：messages 为空', () => {
  const r = mod.useSessionManager()
  assert.deepEqual(r.messages.value, [])
})

// ============ trackMessage ============

test('trackMessage: 空内容不记录', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', '')
  assert.equal(r.messages.value.length, 0)
})

test('trackMessage: user 角色记录并递增 askCount', () => {
  const r = mod.useSessionManager()
  const before = r.askCount.value
  r.trackMessage('user', 'hello')
  assert.equal(r.messages.value.length, 1)
  assert.equal(r.messages.value[0].role, 'user')
  assert.equal(r.messages.value[0].content, 'hello')
  assert.equal(r.askCount.value, before + 1)
})

test('trackMessage: assistant 角色记录但不递增 askCount', () => {
  const r = mod.useSessionManager()
  const before = r.askCount.value
  r.trackMessage('assistant', 'reply')
  assert.equal(r.messages.value.length, 1)
  assert.equal(r.askCount.value, before)
})

test('trackMessage: system 角色记录但不递增 askCount', () => {
  const r = mod.useSessionManager()
  const before = r.askCount.value
  r.trackMessage('system', 'sys')
  assert.equal(r.askCount.value, before)
})

// ============ computed 派生 ============

test('inputTokens: 非 assistant 消息合计', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', 'hello world')
  r.trackMessage('system', 'sys prompt')
  assert.ok(r.inputTokens.value > 0)
})

test('outputTokens: 仅 assistant 消息合计', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', 'hi')
  assert.equal(r.outputTokens.value, 0)
  r.trackMessage('assistant', 'reply')
  assert.ok(r.outputTokens.value > 0)
})

test('totalTokens: inputTokens + outputTokens', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', 'hi there')
  r.trackMessage('assistant', 'hi back')
  assert.equal(r.totalTokens.value, r.inputTokens.value + r.outputTokens.value)
})

test('usagePercent: 空会话为 0', () => {
  const r = mod.useSessionManager()
  assert.equal(r.usagePercent.value, 0)
})

test('usagePercent: 上限 100（Math.min 保护）', () => {
  const r = mod.useSessionManager()
  // 塞超长文本
  r.trackMessage('user', 'x'.repeat(200000))
  assert.ok(r.usagePercent.value <= 100)
})

test('isApproachingLimit: 空会话为 false', () => {
  const r = mod.useSessionManager()
  assert.equal(r.isApproachingLimit.value, false)
})

test('isOverLimit: 空会话为 false', () => {
  const r = mod.useSessionManager()
  assert.equal(r.isOverLimit.value, false)
})

// ============ maybeRotateSession ============

test('maybeRotateSession: askCount 低于阈值 → fired=false', async () => {
  const r = mod.useSessionManager()
  r.resetAskCount()
  const res = await r.maybeRotateSession(() => true)
  assert.equal(res.fired, false)
  assert.equal(res.sent, false)
  assert.equal(res.overCount, 0)
})

test('maybeRotateSession: askCount = 阈值 → fired=true 且重置计数', async () => {
  const r = mod.useSessionManager()
  r.resetAskCount()
  for (let i = 0; i < mod.ASK_ROTATE_THRESHOLD; i++) r.trackMessage('user', `m${i}`)
  assert.equal(r.askCount.value, mod.ASK_ROTATE_THRESHOLD)
  const res = await r.maybeRotateSession(() => true)
  assert.equal(res.fired, true)
  assert.equal(res.sent, true)
  assert.equal(res.overCount, mod.ASK_ROTATE_THRESHOLD)
  assert.equal(r.askCount.value, 0)
})

test('maybeRotateSession: sendFn 返回 false → sent=false', async () => {
  const r = mod.useSessionManager()
  r.resetAskCount()
  for (let i = 0; i < mod.ASK_ROTATE_THRESHOLD; i++) r.trackMessage('user', 'm')
  const res = await r.maybeRotateSession(() => false)
  assert.equal(res.fired, true)
  assert.equal(res.sent, false)
})

// ============ updateSessionUrl ============

test('updateSessionUrl: 更新 sessionUrl', () => {
  const r = mod.useSessionManager()
  r.updateSessionUrl('https://chat.deepseek.com/x')
  assert.equal(r.sessionUrl.value, 'https://chat.deepseek.com/x')
})

// ============ resetSession ============

test('resetSession: 清空 messages 与 askCount', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', 'hi')
  r.trackMessage('assistant', 'there')
  const oldId = r.sessionId.value
  r.resetSession()
  assert.equal(r.messages.value.length, 0)
  assert.equal(r.askCount.value, 0)
  // sessionId 应重新生成（mock 下相同）
  assert.equal(r.sessionId.value, oldId)
})

// ============ generateHandoffSummary ============

test('generateHandoffSummary: 返回字符串且含 Session ID 段', () => {
  const r = mod.useSessionManager()
  const s = r.generateHandoffSummary()
  assert.equal(typeof s, 'string')
  assert.ok(s.includes('Session ID'), 'expect Session ID section')
  assert.ok(s.includes('下一步'), 'expect 下一步 section')
})

test('generateHandoffSummary: 含会话 URL', () => {
  const r = mod.useSessionManager()
  r.updateSessionUrl('http://example.test/x')
  const s = r.generateHandoffSummary()
  assert.ok(s.includes('http://example.test/x'))
})
