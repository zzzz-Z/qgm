// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-tsc-targets.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-tsc-targets.node-test.ts 迁至 test/post-run-tsc-targets.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/tsc-targets.node-test.ts 迁至 client/test/post-run-tsc-targets.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { pickTscTargets, TSC_EXTS, TSC_SKIP_DIRS } from '../../../packages/core/src/post-run/tsc-targets.js'

// AIRUNNER-BATCH10-3B-TEST-TYPES: 显式类型，避免 TS7006
function ch(path: string, type: 'added' | 'modified' | 'deleted') {
  return { path, type }
}

test('空数组 → 空数组', () => {
  assert.deepEqual(pickTscTargets([]), [])
})

test('deleted 条目被排除', () => {
  const r = pickTscTargets([ch('a.ts', 'deleted'), ch('b.ts', 'added')])
  assert.deepEqual(r, ['b.ts'])
})

test('仅保留 TSC_EXTS 后缀（.ts/.tsx/.vue/.mts/.cts）', () => {
  const r = pickTscTargets([
    ch('a.ts', 'added'),
    ch('b.tsx', 'added'),
    ch('c.vue', 'added'),
    ch('d.mts', 'added'),
    ch('e.cts', 'added'),
    ch('f.js', 'added'),
    ch('g.json', 'added'),
    ch('h.md', 'added'),
  ])
  assert.deepEqual(r, ['a.ts', 'b.tsx', 'c.vue', 'd.mts', 'e.cts'])
})

test('大写后缀被识别（.TS）', () => {
  assert.deepEqual(pickTscTargets([ch('A.TS', 'added')]), ['A.TS'])
})

test('TSC_SKIP_DIRS 中的路径被排除', () => {
  const r = pickTscTargets([
    ch('client/e2e/x.spec.ts', 'added'),
    ch('e2e/y.ts', 'added'),
    ch('test/z.ts', 'added'),
    ch('tests/w.ts', 'added'),
    ch('src/keep.ts', 'added'),
  ])
  assert.deepEqual(r, ['src/keep.ts'])
})

test('spec/test 后缀被排除', () => {
  const r = pickTscTargets([
    ch('src/a.spec.ts', 'added'),
    ch('src/b.test.ts', 'added'),
    ch('src/c.spec.tsx', 'added'),
    ch('src/d.test.vue', 'added'),
    ch('src/e.ts', 'added'),
  ])
  assert.deepEqual(r, ['src/e.ts'])
})

test('TSC_EXTS 精确值', () => {
  assert.deepEqual([...TSC_EXTS].sort(), ['.cts', '.mts', '.ts', '.tsx', '.vue'])
})

test('TSC_SKIP_DIRS 精确值', () => {
  assert.deepEqual([...TSC_SKIP_DIRS], ['client/e2e/', 'e2e/', 'test/', 'tests/'])
})

test('相对路径前缀命中（src/ 开头的测试文件不被误排）', () => {
  assert.deepEqual(pickTscTargets([ch('src/test-foo.ts', 'added')]), ['src/test-foo.ts'])
})

test('混合场景：多规则叠加', () => {
  const r = pickTscTargets([
    ch('src/a.ts', 'added'),
    ch('src/b.spec.ts', 'added'),
    ch('src/c.ts', 'deleted'),
    ch('src/d.vue', 'modified'),
    ch('test/e.ts', 'added'),
  ])
  assert.deepEqual(r, ['src/a.ts', 'src/d.vue'])
})
