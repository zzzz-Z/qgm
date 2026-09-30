// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/error-fingerprint.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/error-fingerprint.node-test.ts 迁至 test/error-fingerprint.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
// [P5-4] 动态 import：本文件视为 CJS，静态 import 会触发 TS1479

// [P5-4] error-fingerprint 单测：用 fixture 驱动真实定位

test('[P5-4] fingerprintErrors 定位函数 beta', async () => {
  const { fingerprintErrors } = await import('../../../packages/core/src/utils/error-fingerprint.js')
  const dir = path.join(process.cwd(), '.ai-runner/tmp/fp-fixture')
  fs.mkdirSync(dir, { recursive: true })
  const fixture = path.join(dir, 'sample.ts')
  fs.writeFileSync(fixture, [
    'export function alpha() {',
    '  return 1',
    '}',
    '',
    'export function beta() {',
    '  throw new Error(\'boom\')',
    '}',
  ].join('\n'))

  const fp = fingerprintErrors('.ai-runner/tmp/fp-fixture/sample.ts:6:3')
  assert.ok(fp.length > 0, '应至少命中 1 条指纹')
  assert.equal(fp[0].file, '.ai-runner/tmp/fp-fixture/sample.ts')
  assert.equal(fp[0].line, 6)
  assert.equal(fp[0].symbol, 'beta')
  assert.equal(fp[0].kind, 'function')
})

test('[P5-4] fingerprintErrors 忽略 node_modules', async () => {
  const { fingerprintErrors } = await import('../../../packages/core/src/utils/error-fingerprint.js')
  const fp = fingerprintErrors('node_modules/foo/bar.ts:10:1')
  assert.equal(fp.length, 0)
})

test('[P5-4] fingerprintErrors 定位箭头函数变量名', async () => {
  const { fingerprintErrors } = await import('../../../packages/core/src/utils/error-fingerprint.js')
  const dir = path.join(process.cwd(), '.ai-runner/tmp/fp-fixture')
  fs.mkdirSync(dir, { recursive: true })
  const fixture = path.join(dir, 'arrow.ts')
  fs.writeFileSync(fixture, [
    'const gamma = () => {',
    '  throw new Error(\'x\')',
    '}',
    'export default gamma',
  ].join('\n'))

  const fp = fingerprintErrors('.ai-runner/tmp/fp-fixture/arrow.ts:2:3')
  assert.ok(fp.length > 0, '应至少命中 1 条指纹')
  assert.equal(fp[0].symbol, 'gamma')
})
