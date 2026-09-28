// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-run-script-wrapper.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-run-script-wrapper.node-test.ts 迁至 test/post-run-run-script-wrapper.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/run-script-wrapper.node-test.ts 迁至 client/test/post-run-run-script-wrapper.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { buildWrapperCode } from '../../packages/core/src/post-run/run-script-wrapper.ts'

// AIRUNNER-BATCH11-4-WRAPPER-TEST
const SAMPLE = '/tmp/x/script.cjs'

test('返回值包含 uncaughtException 监听', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('uncaughtException'))
})

test('返回值包含 unhandledRejection 监听', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('unhandledRejection'))
})

test('捕获块将 process.exitCode 置 1', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('process.exitCode = 1'))
})

test('内插 scriptPath 用 JSON 安全转义', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes(JSON.stringify(SAMPLE)))
})

test('特殊字符路径被安全转义', () => {
  const p = '/tmp/a"b/c\\d.cjs'
  const c = buildWrapperCode(p)
  assert.ok(c.includes(JSON.stringify(p)), 'expect JSON-escaped path in output')
})

test('返回值包含 require(scriptPath) 调用', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(/require\(/.test(c))
})

test('返回值包含 [script error] 标签', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('[script error]'))
})

test('返回值含 try / catch 结构', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.ok(c.includes('try {'))
  assert.ok(c.includes('catch(e)'))
})

test('相同入参产生相同输出（确定性）', () => {
  assert.equal(buildWrapperCode(SAMPLE), buildWrapperCode(SAMPLE))
})

test('不同 scriptPath 产生不同输出', () => {
  assert.notEqual(buildWrapperCode('/a.cjs'), buildWrapperCode('/b.cjs'))
})

test('返回值为字符串（非 undefined）', () => {
  const c = buildWrapperCode(SAMPLE)
  assert.equal(typeof c, 'string')
  assert.ok(c.length > 0)
})
