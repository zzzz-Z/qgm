// [panel-resize-scroll-v1] D4：面板出现/消失时聊天流的滚动补偿
// [WHY] 面板在 chat-list 上方，出现时其高度侵占 chat-list → 视觉跳；需按 delta 补偿 scrollTop
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { computeCompensatedScrollTop } from '../utils/panel-resize-scroll.js'

test('D4: 面板出现（delta>0）→ scrollTop += delta', () => {
  assert.equal(computeCompensatedScrollTop(100, 200), 300)
})

test('D4: 面板消失（delta<0）→ scrollTop -= |delta|', () => {
  assert.equal(computeCompensatedScrollTop(300, -200), 100)
})

test('D4: 补偿后不为负（scrollTop 下界 0）', () => {
  assert.equal(computeCompensatedScrollTop(50, -200), 0)
})

test('D4: delta=0 保持不变', () => {
  assert.equal(computeCompensatedScrollTop(123, 0), 123)
})

test('D4: 非有限数 → 返回原值（防御性）', () => {
  assert.equal(computeCompensatedScrollTop(100, Number.NaN), 100)
  assert.equal(computeCompensatedScrollTop(Number.NaN, 100), 0)
})
