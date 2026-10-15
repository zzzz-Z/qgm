// [delivery-routing-v1] pickDeadLetterWrites 承重测试
// [WHY] 判据必须承重：改动此函数若恒返回空数组，本测试应变红。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { pickDeadLetterWrites } from '../src/post-run/run-compliance.js'

test('命中 .ai-runner/ 前缀，其余过滤', () => {
  const out = pickDeadLetterWrites(['.ai-runner/reports/a.md', 'src/x.ts', 'docs/y.md'])
  assert.deepEqual(out, ['.ai-runner/reports/a.md'])
})

test('无 .ai-runner/ 前缀时返回空数组', () => {
  const out = pickDeadLetterWrites(['src/x.ts', 'docs/y.md'])
  assert.deepEqual(out, [])
})

test('去重且上限 10 条', () => {
  const many = []
  for (let i = 0; i < 20; i++) many.push(`.ai-runner/f${i}.md`)
  many.push('.ai-runner/f0.md')
  const out = pickDeadLetterWrites(many)
  assert.equal(out.length, 10)
  assert.equal(new Set(out).size, 10)
  assert.equal(out[0], '.ai-runner/f0.md')
})

test('空数组 / 含空串 / 非 .ai-runner 前缀的干扰项', () => {
  assert.deepEqual(pickDeadLetterWrites([]), [])
  assert.deepEqual(pickDeadLetterWrites(['', 'foo/.ai-runner/x']), [])
})
