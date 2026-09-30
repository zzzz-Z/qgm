// AIRUNNER-BATCH38-1-HANDOFF: auto-loop/handoff.ts Characterization Test
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

// ===== 全局 mock（在 import 之前）=====
const store = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string): string | null => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string): void => { store.set(k, String(v)) },
    removeItem: (k: string): void => { store.delete(k) },
    clear: (): void => { store.clear() },
    key: (i: number): string | null => Array.from(store.keys())[i] ?? null,
    get length(): number { return store.size },
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

// fetch mock（useAiTransport 懒加载 headless 时可能需要）
const origFetch = globalThis.fetch
globalThis.fetch = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

let mod: typeof import('../../../packages/client/composables/ai/auto-loop/handoff')
beforeAll(async () => {
  mod = await import('../../../packages/client/composables/ai/auto-loop/handoff')
})

beforeEach(() => {
  store.clear()
})

// ============ SUMMARY_INSTRUCTION ============
test('SUMMARY_INSTRUCTION: 为非空字符串', () => {
  assert.equal(typeof mod.SUMMARY_INSTRUCTION, 'string')
  assert.ok(mod.SUMMARY_INSTRUCTION.length > 0)
})

test('SUMMARY_INSTRUCTION: 首行为引导语句', () => {
  const firstLine = mod.SUMMARY_INSTRUCTION.split('\n')[0]
  assert.ok(firstLine.includes('总结'), `expect 引导语句: ${firstLine}`)
})

test('SUMMARY_INSTRUCTION: 含 5 个约定章节', () => {
  for (const h of ['# 任务', '# 已完成', '# 当前状态', '# 下一步', '# 关键文件']) {
    assert.ok(mod.SUMMARY_INSTRUCTION.includes(h), `missing section: ${h}`)
  }
})

test('SUMMARY_INSTRUCTION: 末行为「只输出结构」约束', () => {
  const lastLine = mod.SUMMARY_INSTRUCTION.trim().split('\n').pop()!
  assert.ok(lastLine.includes('只输出'), `expect 收尾约束: ${lastLine}`)
})

test('SUMMARY_INSTRUCTION: 不含三反引号（防格式冲突）', () => {
  const triple = String.fromCharCode(96, 96, 96)
  assert.ok(!mod.SUMMARY_INSTRUCTION.includes(triple))
})

// ============ startHandoff 早退分支 ============
test('startHandoff: 无 active loop → 静默返回（不抛错）', async () => {
  await assert.doesNotReject(async () => { await mod.startHandoff() })
})

test('startHandoff: 二次调用仍不抛错', async () => {
  await mod.startHandoff()
  await assert.doesNotReject(async () => { await mod.startHandoff() })
})

// ============ onSummary / onNewSessionCreated 防御性 ============
test('onSummary: 空文本不抛错', async () => {
  await assert.doesNotReject(async () => { await mod.onSummary('', 'sid', false) })
})

test('onSummary: degraded=true 不抛错', async () => {
  await assert.doesNotReject(async () => { await mod.onSummary('hello', 'sid', true) })
})

test('onNewSessionCreated: 空 url / 空 id 不抛错', async () => {
  await assert.doesNotReject(async () => { await mod.onNewSessionCreated('', '') })
})

test('onNewSessionCreated: 合法 url / id 不抛错', async () => {
  await assert.doesNotReject(async () => { await mod.onNewSessionCreated('https://chat.deepseek.com/x', 'sid-1') })
})

// 恢复 fetch
process.on('beforeExit', () => { globalThis.fetch = origFetch })
