// [affected-tests-v1] 受影响测试发现承重守卫。
// @why 判据必须承重（SYSTEM.md §14）：
//   ① 方法存在且 arity=2 —— 防文档与门面漂移；
//   ② 已知改动必命中对应测试 —— 防恒空返回（实现退化成空数组）；
//   ③ 双通道都要有命中 —— 防某一通道失效仍「看起来正常」；
//   ④ 无关文件不得命中全部 —— 防恒真（返回全量测试）。
import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
require(path.join(ROOT, 'packages/core/src/helpers.cjs'))
const AI = (globalThis as unknown as { __AI__: Record<string, unknown> }).__AI__

test('A1 方法存在且 arity=2', () => {
  expect(typeof AI.affectedTests).toBe('function')
  expect((AI.affectedTests as (...a: unknown[]) => unknown).length).toBe(2)
})

test('A2 改动 ai-guard.ts 必命中其两个测试（import 通道）', () => {
  const r = (AI.affectedTests as (f: string[]) => { tests: string[], matched: { via: string }[] })(
    ['packages/core/src/post-run/ai-guard.ts'],
  )
  expect(r.tests).toContain('packages/core/tests/ai-guard.node-test.ts')
  expect(r.tests).toContain('packages/core/tests/api-surface-parity.node-test.ts')
  expect(r.matched.some(m => m.via === 'import')).toBe(true)
})

test('A3 改动 helpers/search.cjs 命中经 barrel 传递的测试', () => {
  const r = (AI.affectedTests as (f: string[]) => { tests: string[] })([
    'packages/core/src/helpers/search.cjs',
  ])
  expect(r.tests.length).toBeGreaterThan(0)
  expect(r.tests).toContain('packages/core/tests/helpers-exec-tool-log.node-test.ts')
})

test('A4 无关文件不得返回全量测试（防恒真）', () => {
  const r = (AI.affectedTests as (f: string[]) => { total: number })(['packages/core/src/does-not-exist.ts'])
  expect(r.total).toBeLessThan(10)
})

test('A5 空输入返回 0 不抛异常', () => {
  const r = (AI.affectedTests as (f: string[]) => { total: number })([])
  expect(r.total).toBe(0)
})
