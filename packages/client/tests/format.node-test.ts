// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/format.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/format.node-test.ts 迁至 test/format.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { fmtSize } from '../../packages/client/utils/format.ts'

// AIRUNNER-BATCH15-4-FORMAT
test('fmtSize: < 1024 字节显示为 NNB', () => {
  assert.equal(fmtSize(0), '0B')
  assert.equal(fmtSize(1), '1B')
  assert.equal(fmtSize(512), '512B')
  assert.equal(fmtSize(1023), '1023B')
})

test('fmtSize: 1024 边界进入 KB', () => {
  assert.equal(fmtSize(1024), '1.0KB')
  assert.equal(fmtSize(1536), '1.5KB')
})

test('fmtSize: KB 段保留 1 位小数', () => {
  assert.equal(fmtSize(2048), '2.0KB')
  assert.equal(fmtSize(1024 * 500), '500.0KB')
})

test('fmtSize: 1024*1024 边界进入 MB', () => {
  assert.equal(fmtSize(1024 * 1024), '1.00MB')
  assert.equal(fmtSize(1024 * 1024 * 2), '2.00MB')
})

test('fmtSize: MB 段保留 2 位小数', () => {
  assert.equal(fmtSize(1024 * 1024 * 1.5), '1.50MB')
  assert.equal(fmtSize(1024 * 1024 * 10.123), '10.12MB')
})

test('fmtSize: 大数值', () => {
  assert.equal(fmtSize(1024 * 1024 * 1024), '1024.00MB')
})
