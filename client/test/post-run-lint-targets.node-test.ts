// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/lint-targets.node-test.ts 迁至 client/test/post-run-lint-targets.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { LINT_EXTS, pickLintTargets } from '../../src/post-run/lint-targets.ts'

function ch(path: string, type: 'added' | 'modified' | 'deleted') { return { path, type } }

test('空数组 → 空数组', () => {
  assert.deepEqual(pickLintTargets([]), [])
})

test('deleted 条目被排除', () => {
  assert.deepEqual(pickLintTargets([ch('a.ts', 'deleted'), ch('b.ts', 'added')]), ['b.ts'])
})

test('保留 7 类扩展名', () => {
  const r = pickLintTargets([
    ch('a.ts', 'added'),
    ch('b.tsx', 'added'),
    ch('c.vue', 'added'),
    ch('d.js', 'added'),
    ch('e.jsx', 'added'),
    ch('f.mjs', 'added'),
    ch('g.cjs', 'added'),
    ch('h.json', 'added'),
    ch('i.md', 'added'),
  ])
  assert.deepEqual(r, ['a.ts', 'b.tsx', 'c.vue', 'd.js', 'e.jsx', 'f.mjs', 'g.cjs'])
})

test('大写扩展名被识别', () => {
  assert.deepEqual(pickLintTargets([ch('A.TS', 'added'), ch('B.VUE', 'added')]), ['A.TS', 'B.VUE'])
})

test('LINT_EXTS 精确值', () => {
  assert.deepEqual([...LINT_EXTS].sort(), ['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx', '.vue'])
})

test('无扩展名不通过', () => {
  assert.deepEqual(pickLintTargets([ch('Makefile', 'added')]), [])
})

test('混合场景', () => {
  const r = pickLintTargets([
    ch('src/a.ts', 'added'),
    ch('src/b.ts', 'deleted'),
    ch('client/x.vue', 'modified'),
    ch('docs/y.md', 'added'),
  ])
  assert.deepEqual(r, ['src/a.ts', 'client/x.vue'])
})
