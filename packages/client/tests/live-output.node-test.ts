// [live-output-cap-v1] 流式输出累积的软上限守卫。
// [判据承重] 把 appendCapped 改回裸 `target.value += text` ⇒ T2 必红（内存会单调增长）。
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { appendCapped, LIVE_OUTPUT_MAX_CHARS } from '../composables/runner/live-output.js'

it('appendCapped：未超上限时原样追加，内容逐字符不变', () => {
  const target = { value: 'abc' }
  appendCapped(target, 'def')
  assert.equal(target.value, 'abcdef')
})

it('appendCapped：超上限时只保留尾部，长度恰为上限', () => {
  const target = { value: '' }
  const chunk = 'x'.repeat(1000)
  for (let i = 0; i < 300; i++) appendCapped(target, chunk, 1024)
  assert.equal(target.value.length, 1024, '必须精确截到上限')
  assert.ok(target.value.endsWith('xxx'), '保留的必须是尾部（最近的输出）')
  assert.ok(target.value.length < 300 * 1000, '不得累积全部历史')
})

it('appendCapped：单次追加即超上限时也正确截断（不会先撑爆再截）', () => {
  const target = { value: '' }
  appendCapped(target, 'y'.repeat(5000), 100)
  assert.equal(target.value.length, 100)
  assert.equal(target.value, 'y'.repeat(100))
})

it('appendCapped：默认上限是 256KB 量级，不吞正常轮次的完整输出', () => {
  assert.ok(LIVE_OUTPUT_MAX_CHARS >= 64 * 1024, '上限过小会误伤正常的长输出')
  const target = { value: '' }
  appendCapped(target, 'z'.repeat(10000))
  assert.equal(target.value.length, 10000, '远低于上限时不得截断')
})
