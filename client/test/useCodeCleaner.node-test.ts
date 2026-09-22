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
};
(globalThis as unknown as { localStorage: unknown }).localStorage = localStorageMock

// 模块级单例在首次 import 时初始化（此时 store 为空），因此初始值均为 true（fallback）
// AIRUNNER-BATCH17-4-FIX-TLA: 去掉顶层 await；改用 before 钩子动态加载（模块单例仅初始化一次）
let useCodeCleaner: typeof import('../composables/runner/useCodeCleaner.ts').useCodeCleaner
before(async () => {
  const mod = await import('../composables/runner/useCodeCleaner.ts')
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

test('toggleStripComments: 写 localStorage 为 \'1\' 并更新 ref', () => {
  store.clear()
  const r = useCodeCleaner()
  r.toggleStripComments(true)
  assert.equal(r.stripComments.value, true)
  assert.equal(store.get(KEY_COMMENTS), '1')
})

test('toggleStripComments: 关时写 \'0\'', () => {
  store.clear()
  const r = useCodeCleaner()
  r.toggleStripComments(false)
  assert.equal(r.stripComments.value, false)
  assert.equal(store.get(KEY_COMMENTS), '0')
})

test('toggleStripBlankLines: 独立于 stripComments', () => {
  store.clear()
  const r = useCodeCleaner()
  r.toggleStripComments(true)
  r.toggleStripBlankLines(false)
  assert.equal(r.stripComments.value, true)
  assert.equal(r.stripBlankLines.value, false)
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
