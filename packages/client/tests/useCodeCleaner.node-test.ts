// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useCodeCleaner.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useCodeCleaner.node-test.ts 迁至 test/useCodeCleaner.node-test.ts
import { beforeAll as before, test } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH17-4-CODE-CLEANER
// useCodeCleaner.ts 是模块级单例：ref 在模块加载时从 localStorage 初始化。
// 测试前先装一个 clean 的 localStorage mock，避免宿主环境污染。

const KEY_COMMENTS = '__ai_clean_strip_comments'
const KEY_BLANKS = '__ai_clean_strip_blanks'

const store = new Map<string, string>()
const localStorageMock = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size },
}
;(globalThis as unknown as { localStorage: unknown }).localStorage = localStorageMock
// [storage-stub] vueuse useStorage 的 `storage instanceof Storage` 探测在 node 环境引用全局
// Storage，缺失时模块导入即崩（[use-storage-v1] 后所有 useStorage 消费方均受影响）
class StorageStub { }
;(globalThis as unknown as { Storage: unknown }).Storage = StorageStub
// [__ai_codecleaner_win_bridge__] vueuse useStorage 读 window.localStorage（不是 globalThis）；
// 缺此桥 → useStorage 走内存兜底 → 测试读底层 store 永远 null，多断言恒红
;(globalThis as unknown as { window: unknown }).window = {
  localStorage: localStorageMock,
  // [storage-listen-stub] useStorage listenToStorageChanges 会挂自定义事件监听，缺法则导入期抛错
  addEventListener: (): void => {},
  removeEventListener: (): void => {},
}
// [__ai_codecleaner_doc_stub__] vueuse isClient = (typeof window && typeof document);
// 仅桥 window 不够 → 仍走内存兜底，写入永不落 mock。补最小 document stub
;(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }

// 模块级单例在首次 import 时初始化（此时 store 为空），因此初始值均为 true（fallback）
// AIRUNNER-BATCH17-4-FIX-TLA: 去掉顶层 await；改用 before 钩子动态加载（模块单例仅初始化一次）
// [ts5097-fix] 去 .ts 后缀：tsconfig.client.json 未启用 allowImportingTsExtensions
let useCodeCleaner: typeof import('../composables/runner/useCodeCleaner').useCodeCleaner
before(async () => {
  const mod = await import('../composables/runner/useCodeCleaner')
  useCodeCleaner = mod.useCodeCleaner
})

test('useCodeCleaner: 返回单例 ref 与 toggle', () => {
  const r = useCodeCleaner()
  assert.equal(typeof r.stripComments, 'object')
  assert.equal(typeof r.stripBlankLines, 'object')
  assert.equal(typeof r.toggleStripComments, 'function')
  assert.equal(typeof r.toggleStripBlankLines, 'function')
})

test('useCodeCleaner: 多次调用返回同一组 ref（模块级单例）', () => {
  const a = useCodeCleaner()
  const b = useCodeCleaner()
  assert.equal(a.stripComments, b.stripComments)
  assert.equal(a.stripBlankLines, b.stripBlankLines)
})

test('useCodeCleaner: 首次 import 时 store 空 → 默认 true（fallback）', () => {
  const r = useCodeCleaner()
  assert.equal(r.stripComments.value, true)
  assert.equal(r.stripBlankLines.value, true)
})

test('toggleStripComments: 写 localStorage 为 \'1\' 并更新 ref', async () => {
  store.clear()
  const r = useCodeCleaner()
  // [use-storage-v1] useStorage 仅在值变化时落盘（模块单例 ref 可能已是 true），
  // 先置反值再置目标值，保证最后一次变化一定触发写入
  r.toggleStripComments(false)
  await new Promise(resolve => setTimeout(resolve, 0))
  r.toggleStripComments(true)
  assert.equal(r.stripComments.value, true)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.get(KEY_COMMENTS), '1')
})

test('toggleStripComments: 关时写 \'0\'', async () => {
  store.clear()
  const r = useCodeCleaner()
  r.toggleStripComments(false)
  assert.equal(r.stripComments.value, false)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.get(KEY_COMMENTS), '0')
})

test('toggleStripBlankLines: 独立于 stripComments', async () => {
  store.clear()
  const r = useCodeCleaner()
  r.toggleStripComments(true)
  r.toggleStripBlankLines(false)
  assert.equal(r.stripComments.value, true)
  assert.equal(r.stripBlankLines.value, false)
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(store.get(KEY_BLANKS), '0')
})

test('toggleStripComments: localStorage 抛错时静默（ref 仍更新）', () => {
  const r = useCodeCleaner()
  const orig = localStorageMock.setItem
  localStorageMock.setItem = () => { throw new Error('quota') }
  try {
    r.toggleStripComments(true)
    assert.equal(r.stripComments.value, true)
  } finally {
    localStorageMock.setItem = orig
  }
})

test('toggle 反复切换：ref 值反映最后一次', () => {
  const r = useCodeCleaner()
  r.toggleStripComments(false)
  r.toggleStripComments(true)
  r.toggleStripComments(false)
  assert.equal(r.stripComments.value, false)
})
