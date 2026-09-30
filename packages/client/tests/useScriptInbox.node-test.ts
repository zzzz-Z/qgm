// AIRUNNER-BATCH39-2-USE-SCRIPT-INBOX: useScriptInbox.ts Characterization Test
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

// crypto.randomUUID mock（Node 20+ 有，但显式提供避免环境差异）
let uuidCounter = 0
Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  writable: true,
  value: {
    randomUUID: (): string => {
      uuidCounter++
      const hex = uuidCounter.toString(16).padStart(8, '0')
      return `${hex}-0000-0000-0000-000000000000`
    },
  },
})

let mod: typeof import('../../../packages/client/composables/runner/useScriptInbox')
let useRunnerMod: typeof import('../../../packages/client/composables/runner/useRunner')
beforeAll(async () => {
  mod = await import('../../../packages/client/composables/runner/useScriptInbox')
  useRunnerMod = await import('../../../packages/client/composables/runner/useRunner')
})

beforeEach(() => {
  mod.clearInbox()
  mod.setLastAutoFilled('')
  useRunnerMod.useRunner().script.value = ''
})

// ============ push ============

test('push: 有效 code 返回带 id 的 item 并进入队列', () => {
  const it = mod.push({ code: 'const a = 1', lang: 'js', site: 'test' })
  assert.ok(it)
  assert.ok(it.id.startsWith('inb_'))
  assert.equal(it.code, 'const a = 1')
  assert.equal(it.lang, 'js')
  assert.equal(it.site, 'test')
  assert.equal(mod.peekAll().length, 1)
})

test('push: 空 code → null，不入队', () => {
  const it = mod.push({ code: '   ', lang: 'js', site: 'test' })
  assert.equal(it, null)
  assert.equal(mod.peekAll().length, 0)
})

test('push: 二次同 code 去重（返回 null）', () => {
  const a = mod.push({ code: 'const x = 1', lang: 'js', site: 'test' })
  const b = mod.push({ code: 'const x = 1', lang: 'js', site: 'test' })
  assert.ok(a)
  assert.equal(b, null)
  assert.equal(mod.peekAll().length, 1)
})

test('push: 注释差异被归一化（视为重复）', () => {
  const a = mod.push({ code: '// hello\nconst x = 1', lang: 'js', site: 'test' })
  const b = mod.push({ code: '// different comment\nconst x = 1', lang: 'js', site: 'test' })
  assert.ok(a)
  assert.equal(b, null)
  assert.equal(mod.peekAll().length, 1)
})

test('push: 空白差异被归一化（视为重复）', () => {
  const a = mod.push({ code: 'const x=1', lang: 'js', site: 'test' })
  const b = mod.push({ code: 'const  x  =  1', lang: 'js', site: 'test' })
  assert.ok(a)
  assert.equal(b, null)
})

test('push: 不同 code 均可入队', () => {
  const a = mod.push({ code: 'const a = 1', lang: 'js', site: 'test' })
  const b = mod.push({ code: 'const b = 2', lang: 'js', site: 'test' })
  assert.ok(a)
  assert.ok(b)
  assert.equal(mod.peekAll().length, 2)
})

test('push: desc/why 从 code 的 @desc/@why 解析', () => {
  const code = '#!/usr/bin/env node\n// @desc: 从代码解析\n// @why: 因为测试\nconsole.log(1)'
  const it = mod.push({ code, lang: 'js', site: 'test' })
  assert.ok(it)
  assert.equal(it.desc, '从代码解析')
  assert.equal(it.why, '因为测试')
})

test('push: 无 @desc 时 desc 为空串', () => {
  const it = mod.push({ code: 'console.log(1)', lang: 'js', site: 'test' })
  assert.ok(it)
  assert.equal(it.desc, '')
  assert.equal(it.why, '')
})

// ============ consume / consumeById ============

test('consume: 空队列返回 null', () => {
  assert.equal(mod.consume(), null)
})

test('consume: FIFO 出队', () => {
  const a = mod.push({ code: 'const a = 1', lang: 'js', site: 'test' })!
  mod.push({ code: 'const b = 2', lang: 'js', site: 'test' })
  const out = mod.consume()
  assert.ok(out)
  assert.equal(out.id, a.id)
  assert.equal(mod.peekAll().length, 1)
})

test('consumeById: 不存在的 id 返回 null', () => {
  assert.equal(mod.consumeById('nope'), null)
})

test('consumeById: 指定 id 出队', () => {
  const a = mod.push({ code: 'const a = 1', lang: 'js', site: 'test' })!
  const b = mod.push({ code: 'const b = 2', lang: 'js', site: 'test' })!
  const out = mod.consumeById(b.id)
  assert.ok(out)
  assert.equal(out.id, b.id)
  assert.equal(mod.peekAll().length, 1)
  assert.equal(mod.peekAll()[0].id, a.id)
})

// ============ clearInbox / peekAll ============

test('clearInbox: 清空', () => {
  mod.push({ code: 'const a = 1', lang: 'js', site: 'test' })
  mod.push({ code: 'const b = 2', lang: 'js', site: 'test' })
  mod.clearInbox()
  assert.equal(mod.peekAll().length, 0)
})

test('peekAll: 只读，不消费', () => {
  mod.push({ code: 'const a = 1', lang: 'js', site: 'test' })
  const p1 = mod.peekAll()
  const p2 = mod.peekAll()
  assert.equal(p1.length, 1)
  assert.equal(p2.length, 1)
})

// ============ lastAutoFilled ============

test('getLastAutoFilled / setLastAutoFilled 读写', () => {
  mod.setLastAutoFilled('xyz')
  assert.equal(mod.getLastAutoFilled(), 'xyz')
})

test('setLastAutoFilled 空串复位', () => {
  mod.setLastAutoFilled('x')
  mod.setLastAutoFilled('')
  assert.equal(mod.getLastAutoFilled(), '')
})

// ============ applyToEditor ============

test('applyToEditor: 编辑器为空 → overwritten 并写入', () => {
  useRunnerMod.useRunner().script.value = ''
  const item = mod.push({ code: 'const newcode = 1', lang: 'js', site: 'test' })!
  const r = mod.applyToEditor(item)
  assert.equal(r, 'overwritten')
  assert.equal(useRunnerMod.useRunner().script.value, 'const newcode = 1')
})

test('applyToEditor: 编辑器内容 === lastAutoFilled → overwritten', () => {
  useRunnerMod.useRunner().script.value = 'old-auto'
  mod.setLastAutoFilled('old-auto')
  const item = mod.push({ code: 'const newcode2 = 1', lang: 'js', site: 'test' })!
  const r = mod.applyToEditor(item)
  assert.equal(r, 'overwritten')
  assert.equal(useRunnerMod.useRunner().script.value, 'const newcode2 = 1')
})

test('applyToEditor: 编辑器有手写内容 → queued（保护）', () => {
  useRunnerMod.useRunner().script.value = 'user typing...'
  mod.setLastAutoFilled('other-auto')
  const item = mod.push({ code: 'const newcode3 = 1', lang: 'js', site: 'test' })!
  const r = mod.applyToEditor(item)
  assert.equal(r, 'queued')
  assert.equal(useRunnerMod.useRunner().script.value, 'user typing...')
})

test('applyToEditor: overwritten 后 lastAutoFilled 同步为新 code', () => {
  useRunnerMod.useRunner().script.value = ''
  const item = mod.push({ code: 'const sync_me = 1', lang: 'js', site: 'test' })!
  mod.applyToEditor(item)
  assert.equal(mod.getLastAutoFilled(), 'const sync_me = 1')
})

// ============ useScriptInbox API 面 ============

test('useScriptInbox: 返回完整 API 面', () => {
  const r = mod.useScriptInbox()
  for (const k of ['inbox', 'push', 'consume', 'consumeById', 'clearInbox', 'peekAll', 'getLastAutoFilled', 'setLastAutoFilled', 'applyToEditor'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('useScriptInbox: 多次调用返回同一 inbox ref（模块单例）', () => {
  const a = mod.useScriptInbox()
  const b = mod.useScriptInbox()
  assert.equal(a.inbox, b.inbox)
})
