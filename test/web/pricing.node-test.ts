// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/pricing.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/pricing.node-test.ts 迁至 test/pricing.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { estimateCost, formatCost } from '../../client/utils/pricing.ts'

// AIRUNNER-BATCH15-5-PRICING

test('estimateCost: 未知 model → null', () => {
  assert.equal(estimateCost('nope', { prompt_tokens: 100, completion_tokens: 200 }), null)
})

test('estimateCost: 已知 model 基础计算', () => {
  const u = { prompt_tokens: 1000000, completion_tokens: 1000000 }
  const cost = estimateCost('deepseek-reasoner', u)
  assert.ok(cost !== null)
  // input 4e-6 * 1e6 + output 16e-6 * 1e6 = 4 + 16 = 20
  assert.ok(Math.abs(cost - 20) < 1e-6)
})

test('estimateCost: 负数被钳为 0', () => {
  const r = estimateCost('deepseek-reasoner', { prompt_tokens: -100, completion_tokens: -100 })
  assert.equal(r, 0)
})

test('estimateCost: 零 tokens → 0', () => {
  assert.equal(estimateCost('deepseek-reasoner', { prompt_tokens: 0, completion_tokens: 0 }), 0)
})

test('estimateCost: 非法数值（NaN/undefined）被钳为 0', () => {
  // AIRUNNER-BATCH15-5-FIX-UNDEF: undefined 不可赋给 number，改用 NaN
  const r = estimateCost('deepseek-reasoner', { prompt_tokens: Number.NaN, completion_tokens: Number.NaN })
  assert.equal(r, 0)
})

test('formatCost: null → 未知', () => {
  assert.equal(formatCost(null), '未知')
})

test('formatCost: NaN / Infinity → 未知', () => {
  assert.equal(formatCost(NaN), '未知')
  assert.equal(formatCost(Infinity), '未知')
  assert.equal(formatCost(-Infinity), '未知')
})

test('formatCost: < 0.01 → <¥0.01', () => {
  assert.equal(formatCost(0), '<¥0.01')
  assert.equal(formatCost(0.005), '<¥0.01')
  assert.equal(formatCost(0.0099), '<¥0.01')
})

test('formatCost: 0.01 边界 → ¥0.01', () => {
  assert.equal(formatCost(0.01), '¥0.01')
})

test('formatCost: 常规值保留 2 位小数', () => {
  assert.equal(formatCost(1), '¥1.00')
  assert.equal(formatCost(12.345), '¥12.35')
})
