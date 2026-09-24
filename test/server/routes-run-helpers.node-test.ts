// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/routes-run-helpers.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/routes-run-helpers.node-test.ts 迁至 test/routes-run-helpers.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/routes/run-helpers.node-test.ts 迁至 client/test/routes-run-helpers.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { computeClaimMismatch, computeCompliance } from '../../packages/core/src/post-run/run-helpers.ts'

// AIRUNNER-BATCH20-6-RUN-HELPERS

// ============ computeCompliance ============
test('computeCompliance: 空 script + 空 desc → 全 false', () => {
  assert.deepEqual(computeCompliance('', ''), { hasDesc: false, hasSelfCheck: false, isDecision: false })
})

test('computeCompliance: desc 非空 → hasDesc=true', () => {
  const r = computeCompliance('', 'something')
  assert.equal(r.hasDesc, true)
})

test('computeCompliance: 含 __AI__.assert → hasSelfCheck=true', () => {
  const r = computeCompliance('__AI__.assert(1, 0)', '')
  assert.equal(r.hasSelfCheck, true)
})

test('computeCompliance: 含裸 .assert( → hasSelfCheck=true', () => {
  const r = computeCompliance('foo.assert(1, 0)', '')
  assert.equal(r.hasSelfCheck, true)
})

test('computeCompliance: 含 process.exit(1) → hasSelfCheck=true', () => {
  const r = computeCompliance('if (bad) process.exit(1)', '')
  assert.equal(r.hasSelfCheck, true)
})

test('computeCompliance: 含 __AI__.exitNeedInput → isDecision=true', () => {
  const r = computeCompliance('await __AI__.exitNeedInput()', '')
  assert.equal(r.isDecision, true)
})

test('computeCompliance: 含 __AI_RUNNER_DECISION__ → isDecision=true', () => {
  const r = computeCompliance('console.log(__AI_RUNNER_DECISION__)', '')
  assert.equal(r.isDecision, true)
})

test('computeCompliance: 完整脚本命中全部特征', () => {
  const NL = String.fromCharCode(10)
  const script = ['#!/usr/bin/env node', '// @desc: 例子', 'try {', '  __AI__.assert(true, 0)', '} catch {}', 'await __AI__.exitNeedInput()'].join(NL)
  const r = computeCompliance(script, '例子')
  assert.deepEqual(r, { hasDesc: true, hasSelfCheck: true, isDecision: true })
})

test('computeCompliance: 无自我检查代码 → hasSelfCheck=false', () => {
  const r = computeCompliance('console.log(1)', '')
  assert.equal(r.hasSelfCheck, false)
})

// ============ computeClaimMismatch ============
test('computeClaimMismatch: claimed=null → null', () => {
  assert.equal(computeClaimMismatch(null, []), null)
  assert.equal(computeClaimMismatch(null, [{ path: 'a' }]), null)
})

test('computeClaimMismatch: 空 claimed + 空 actual → 全空', () => {
  const r = computeClaimMismatch([], [])
  assert.ok(r)
  assert.deepEqual(r, { claimed: [], actual: [], missing: [], extra: [] })
})

test('computeClaimMismatch: claimed 与 actual 完全一致 → missing/extra 空', () => {
  const r = computeClaimMismatch(['a.ts', 'b.ts'], [{ path: 'a.ts' }, { path: 'b.ts' }])
  assert.ok(r)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.extra, [])
  assert.deepEqual(r.claimed, ['a.ts', 'b.ts'])
})

test('computeClaimMismatch: claimed 有但 actual 无 → missing', () => {
  const r = computeClaimMismatch(['a.ts', 'b.ts'], [{ path: 'a.ts' }])
  assert.ok(r)
  assert.deepEqual(r.missing, ['b.ts'])
  assert.deepEqual(r.extra, [])
})

test('computeClaimMismatch: actual 有但 claimed 无 → extra', () => {
  const r = computeClaimMismatch(['a.ts'], [{ path: 'a.ts' }, { path: 'c.ts' }])
  assert.ok(r)
  assert.deepEqual(r.missing, [])
  assert.deepEqual(r.extra, ['c.ts'])
})

test('computeClaimMismatch: claimed 与 actual 完全不相交', () => {
  const r = computeClaimMismatch(['a.ts'], [{ path: 'b.ts' }])
  assert.ok(r)
  assert.deepEqual(r.missing, ['a.ts'])
  assert.deepEqual(r.extra, ['b.ts'])
})

test('computeClaimMismatch: actual 原样保留 claimed 顺序', () => {
  const r = computeClaimMismatch(['b', 'a', 'c'], [{ path: 'a' }, { path: 'b' }])
  assert.ok(r)
  assert.deepEqual(r.claimed, ['b', 'a', 'c'])
})

test('computeClaimMismatch: actual 的 path 被映射', () => {
  const r = computeClaimMismatch([], [{ path: 'x' }, { path: 'y' }])
  assert.ok(r)
  assert.deepEqual(r.actual, ['x', 'y'])
  assert.deepEqual(r.extra, ['x', 'y'])
})
