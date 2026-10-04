// [site-isolate-v1] 站点隔离契约：会话历史 / 激活会话按 modelId 分桶
// [WHY] App.vue + AiWindowList 已按 modelId 分流；此处锁死存储层语义，防止未来重构误删分桶或迁移回退
// [CONSTRAINT] 必须在 import 之前 mock localStorage / window / sessionStorage / crypto（useAppStorage 依赖 useStorage 单例）
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

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

type AppStorageMod = typeof import('../../../packages/client/composables/ui/useAppStorage')
let mod: AppStorageMod

// [CONSTRAINT] 一次性动态 import，beforeEach 只清存储；useAppStorage 顶层 useStorage 单例只初始化一次，不需要每测重置
const ready = (async () => {
  mod = await import('../../../packages/client/composables/ui/useAppStorage')
})()

beforeEach(async () => {
  await ready
  lsStore.clear()
})

// ============ API 面 ============

test('[site-isolate-v1] 四个分桶 API 均导出', () => {
  for (const k of [
    'loadHistoryBySite',
    'saveHistoryBySite',
    'loadActiveSessionIdBySite',
    'saveActiveSessionIdBySite',
  ] as const) {
    assert.equal(typeof (mod as unknown as Record<string, unknown>)[k], 'function', `missing: ${k}`)
  }
})

// ============ 会话历史分桶 ============

test('saveHistoryBySite / loadHistoryBySite：同站点可写可读', async () => {
  await ready
  mod.saveHistoryBySite('deepseek', [
    { id: 's1', url: 'https://chat.deepseek.com/a/chat/s/1', title: 't1', createdAt: 1 },
  ])
  const got = mod.loadHistoryBySite('deepseek')
  assert.equal(got.length, 1)
  assert.equal(got[0].id, 's1')
})

test('loadHistoryBySite：不同站点相互隔离，不串历史', async () => {
  await ready
  mod.saveHistoryBySite('deepseek', [
    { id: 'ds-1', url: 'u1', title: 'a', createdAt: 1 },
  ])
  mod.saveHistoryBySite('chatgpt', [
    { id: 'gpt-1', url: 'u2', title: 'b', createdAt: 2 },
  ])

  const ds = mod.loadHistoryBySite('deepseek')
  const gpt = mod.loadHistoryBySite('chatgpt')
  assert.equal(ds.length, 1)
  assert.equal(ds[0].id, 'ds-1')
  assert.equal(gpt.length, 1)
  assert.equal(gpt[0].id, 'gpt-1')

  // 未写入过的站点为空，不继承他站数据
  const claude = mod.loadHistoryBySite('claude')
  assert.equal(claude.length, 0)
})

test('loadHistoryBySite：无站点专属键时不再回退全局键（站点隔离）', async () => {
  await ready
  // [site-isolate-fix-v1] 老版本遗留的全局键不再被新站点继承，避免跨站点历史串味。
  // [CONSTRAINT] 用未在其它用例写过的站点 id：统一 store 是内存单例，跨用例残留会污染断言
  localStorage.setItem('__ai_session_history', JSON.stringify([
    { id: 'legacy-1', url: 'u', title: 't', createdAt: 1 },
  ]))
  const got = mod.loadHistoryBySite('isolated-fresh-site')
  assert.equal(got.length, 0)
})

test('saveHistoryBySite：只落站点键，不污染全局键', async () => {
  await ready
  mod.saveHistoryBySite('deepseek', [
    { id: 'only-ds', url: 'u', title: 't', createdAt: 1 },
  ])
  // 全局键应仍为空（除非被显式写入）
  assert.equal(localStorage.getItem('__ai_session_history'), null)
  assert.notEqual(localStorage.getItem('__ai_session_history__deepseek'), null)
})

// ============ 激活会话 id 分桶 ============

test('saveActiveSessionIdBySite / loadActiveSessionIdBySite：同站点可写可读', async () => {
  await ready
  mod.saveActiveSessionIdBySite('deepseek', 'sess-ds-1')
  assert.equal(mod.loadActiveSessionIdBySite('deepseek'), 'sess-ds-1')
})

test('loadActiveSessionIdBySite：不同站点各存各的，互不覆盖', async () => {
  await ready
  mod.saveActiveSessionIdBySite('deepseek', 'ds-A')
  mod.saveActiveSessionIdBySite('chatgpt', 'gpt-B')
  assert.equal(mod.loadActiveSessionIdBySite('deepseek'), 'ds-A')
  assert.equal(mod.loadActiveSessionIdBySite('chatgpt'), 'gpt-B')
  assert.equal(mod.loadActiveSessionIdBySite('claude'), '')
})

test('loadActiveSessionIdBySite：无站点专属键时不再回退全局键（站点隔离）', async () => {
  await ready
  // [site-isolate-fix-v1] 全局键不参与回退：新站点激活会话一律为空。
  // [CONSTRAINT] 用未在其它用例写过的站点 id：统一 store 是内存单例，跨用例残留会污染断言
  localStorage.setItem('__ai_active_session_id', 'legacy-active')
  assert.equal(mod.loadActiveSessionIdBySite('isolated-fresh-site-2'), '')
})

// ============ 键名约定 ============

test('分桶键前缀符合命名约定', async () => {
  await ready
  mod.saveHistoryBySite('deepseek', [])
  mod.saveActiveSessionIdBySite('deepseek', 'x')
  const keys = Array.from(lsStore.keys())
  assert.ok(keys.includes('__ai_session_history__deepseek'), 'missing history site key')
  assert.ok(keys.includes('__ai_active_session_id__deepseek'), 'missing active site key')
})
