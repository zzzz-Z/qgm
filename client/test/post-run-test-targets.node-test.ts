// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/test-targets.node-test.ts 迁至 client/test/post-run-test-targets.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { buildTestArgs } from '../../src/post-run/test-targets.ts'

// AIRUNNER-BATCH11-3-SPLIT-TEST-TEST
test('空列表 → ran=false, args=[]', () => {
  assert.deepEqual(buildTestArgs([]), { ran: false, args: [] })
})

test('仅 .js 文件 → 不加 strip-types', () => {
  assert.deepEqual(buildTestArgs(['a.test.cjs']), { ran: true, args: ['--test', 'a.test.cjs'] })
})

test('.ts 文件 → 加 --experimental-strip-types', () => {
  assert.deepEqual(buildTestArgs(['a.node-test.ts']), { ran: true, args: ['--test', '--experimental-strip-types', 'a.node-test.ts'] })
})

test('.mts 文件触发 strip-types', () => {
  const r = buildTestArgs(['x.mts'])
  assert.equal(r.ran, true)
  assert.ok(r.args.includes('--experimental-strip-types'))
})

test('.cts 文件触发 strip-types', () => {
  const r = buildTestArgs(['y.cts'])
  assert.ok(r.args.includes('--experimental-strip-types'))
})

test('混合：任一 .ts → 全列表统一加 strip', () => {
  const r = buildTestArgs(['a.cjs', 'b.ts', 'c.js'])
  assert.deepEqual(r, { ran: true, args: ['--test', '--experimental-strip-types', 'a.cjs', 'b.ts', 'c.js'] })
})

test('全 .cjs → 无 strip', () => {
  const r = buildTestArgs(['a.test.cjs', 'b.test.cjs'])
  assert.deepEqual(r.args, ['--test', 'a.test.cjs', 'b.test.cjs'])
})

test('args 首项固定为 --test', () => {
  assert.equal(buildTestArgs(['x.js']).args[0], '--test')
  assert.equal(buildTestArgs(['x.ts']).args[0], '--test')
})

test('文件顺序在 args 中保留', () => {
  const r = buildTestArgs(['z.ts', 'a.ts', 'm.ts'])
  assert.deepEqual(r.args.slice(2), ['z.ts', 'a.ts', 'm.ts'])
})

test('大写后缀 .TS 不触发 strip（regex 大小写敏感，与实现一致）', () => {
  const r = buildTestArgs(['a.TS'])
  assert.equal(r.args.includes('--experimental-strip-types'), false)
})
