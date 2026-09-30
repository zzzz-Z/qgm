// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-compliance.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-compliance.node-test.ts 迁至 test/post-run-compliance.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/compliance.node-test.ts 迁至 client/test/post-run-compliance.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { clearRulesHashCache, hashRules } from '../../../packages/core/src/post-run/compliance.js'

// AIRUNNER-BATCH10-7-INLINE-ROOT-TEST
test('hashRules 返回 8 位十六进制或 unknown', () => {
  clearRulesHashCache()
  const h = hashRules()
  assert.equal(typeof h, 'string')
  assert.ok(/^[0-9a-f]{8}$/.test(h) || h === 'unknown', `unexpected: ${h}`)
})

test('hashRules 二次调用返回同值（缓存生效）', () => {
  clearRulesHashCache()
  const a = hashRules()
  const b = hashRules()
  assert.equal(a, b)
})

test('clearRulesHashCache 后再次调用结果稳定', () => {
  clearRulesHashCache()
  const a = hashRules()
  clearRulesHashCache()
  const b = hashRules()
  assert.equal(a, b, '同一磁盘状态下两次清缓存后应得到相同 hash')
})

test('hashRules 不抛异常（无论 skills 目录是否存在）', () => {
  const prev = process.env.AI_RUNNER_ROOT
  process.env.AI_RUNNER_ROOT = '/tmp/nonexistent-ai-runner-root-xyz'
  try {
    clearRulesHashCache()
    const h = hashRules()
    assert.equal(typeof h, 'string')
    assert.ok(/^[0-9a-f]{8}$/.test(h) || h === 'unknown')
  } finally {
    if (prev === undefined) delete process.env.AI_RUNNER_ROOT
    else process.env.AI_RUNNER_ROOT = prev
    clearRulesHashCache()
  }
})

test('hashRules 稳定：连续 3 次同值', () => {
  clearRulesHashCache()
  const a = hashRules()
  const b = hashRules()
  const c = hashRules()
  assert.equal(a, b)
  assert.equal(b, c)
})
