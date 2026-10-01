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

let mod: typeof import('../composables/ai/useSessionManager.js')
beforeAll(async () => {
  mod = await import('../composables/ai/useSessionManager.js')
})

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
  const r = mod.useSessionManager()
  r.resetSession()
  r.messages.value = []
})

// ============ 常量 ============

// ============ API 面 ============

test('useSessionManager: 返回完整 API 面', () => {
  const r = mod.useSessionManager()
  for (const k of [
    'sessionId',
    'sessionUrl',
    'messages',
    'trackMessage',
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

test('trackMessage: user 角色记录', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', 'hello')
  assert.equal(r.messages.value.length, 1)
  assert.equal(r.messages.value[0].role, 'user')
  assert.equal(r.messages.value[0].content, 'hello')
})

test('trackMessage: assistant 角色记录', () => {
  const r = mod.useSessionManager()
  r.trackMessage('assistant', 'reply')
  assert.equal(r.messages.value.length, 1)
})

test('trackMessage: system 角色记录', () => {
  const r = mod.useSessionManager()
  r.trackMessage('system', 'sys')
  assert.equal(r.messages.value.length, 1)
})

// ============ updateSessionUrl ============

test('updateSessionUrl: 更新 sessionUrl', () => {
  const r = mod.useSessionManager()
  r.updateSessionUrl('https://chat.deepseek.com/x')
  assert.equal(r.sessionUrl.value, 'https://chat.deepseek.com/x')
})

// ============ resetSession ============

test('resetSession: 清空 messages', () => {
  const r = mod.useSessionManager()
  r.trackMessage('user', 'hi')
  r.trackMessage('assistant', 'there')
  const oldId = r.sessionId.value
  r.resetSession()
  assert.equal(r.messages.value.length, 0)
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
