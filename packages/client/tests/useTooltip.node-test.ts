// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useTooltip.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useTooltip.node-test.ts 迁至 test/useTooltip.node-test.ts
// AIRUNNER-BATCH21-6-MOVE-TIMERS: mock.timers 已迁至 beforeEach
import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH17-5-USE-TOOLTIP
// 顶层启用 setTimeout mock（不是 await，允许）

let useTooltip: typeof import('../../../packages/client/composables/ui/useTooltip').useTooltip
let showTooltip: typeof import('../../../packages/client/composables/ui/useTooltip').showTooltip
let moveTooltip: typeof import('../../../packages/client/composables/ui/useTooltip').moveTooltip
let hideTooltip: typeof import('../../../packages/client/composables/ui/useTooltip').hideTooltip

before(async () => {
  const mod = await import('../../../packages/client/composables/ui/useTooltip')
  useTooltip = mod.useTooltip
  showTooltip = mod.showTooltip
  moveTooltip = mod.moveTooltip
  hideTooltip = mod.hideTooltip
})

function resetState(): void {
  // 强制 visible=false 并清掉所有挂起定时器
  const st = useTooltip().state
  if (st.value.visible) {
    hideTooltip()
    vi.advanceTimersByTime(200)
  }
  vi.useFakeTimers()
  vi.useFakeTimers()
}

beforeEach(() => { resetState() })

test('useTooltip: 返回 state + 三函数', () => {
  const r = useTooltip()
  assert.equal(typeof r.state, 'object')
  assert.equal(typeof r.showTooltip, 'function')
  assert.equal(typeof r.moveTooltip, 'function')
  assert.equal(typeof r.hideTooltip, 'function')
})

test('useTooltip: 多次调用返回同一 state（模块单例）', () => {
  const a = useTooltip()
  const b = useTooltip()
  assert.equal(a.state, b.state)
})

test('showTooltip: 空字符串不设置定时器（tick 后 visible 仍 false）', () => {
  const st = useTooltip().state
  showTooltip('', 0, 0)
  vi.advanceTimersByTime(1000)
  assert.equal(st.value.visible, false)
})

test('showTooltip: 300ms 后 visible=true 且 text/x/y 正确', () => {
  const st = useTooltip().state
  showTooltip('hello', 10, 20)
  vi.advanceTimersByTime(299)
  assert.equal(st.value.visible, false, 'before threshold')
  vi.advanceTimersByTime(2)
  assert.equal(st.value.visible, true)
  assert.equal(st.value.text, 'hello')
  assert.equal(st.value.x, 10)
  assert.equal(st.value.y, 20)
})

test('showTooltip: 连续两次调用，后者覆盖（前一次取消）', () => {
  const st = useTooltip().state
  showTooltip('first', 1, 1)
  vi.advanceTimersByTime(100)
  showTooltip('second', 2, 2)
  vi.advanceTimersByTime(300)
  assert.equal(st.value.text, 'second')
  assert.equal(st.value.x, 2)
})

test('hideTooltip: visible=false 时不设置隐藏定时器（幂等）', () => {
  const st = useTooltip().state
  assert.equal(st.value.visible, false)
  hideTooltip()
  vi.advanceTimersByTime(1000)
  assert.equal(st.value.visible, false)
})

test('hideTooltip: visible=true 时 80ms 后变为 false', () => {
  const st = useTooltip().state
  showTooltip('t', 5, 6)
  vi.advanceTimersByTime(300)
  assert.equal(st.value.visible, true)
  hideTooltip()
  vi.advanceTimersByTime(79)
  assert.equal(st.value.visible, true, 'before threshold')
  vi.advanceTimersByTime(2)
  assert.equal(st.value.visible, false)
})

test('moveTooltip: visible=true 时更新 x/y', () => {
  const st = useTooltip().state
  showTooltip('t', 1, 2)
  vi.advanceTimersByTime(300)
  moveTooltip(100, 200)
  assert.equal(st.value.x, 100)
  assert.equal(st.value.y, 200)
  assert.equal(st.value.text, 't')
  assert.equal(st.value.visible, true)
})

test('moveTooltip: visible=false 时不改变 state', () => {
  const st = useTooltip().state
  assert.equal(st.value.visible, false)
  const before = { ...st.value }
  moveTooltip(999, 888)
  assert.deepEqual(st.value, before)
})

test('showTooltip 后 hideTooltip：SHOW 未 fire 时 HIDE 取消挂起（visible 仍 false）', () => {
  const st = useTooltip().state
  showTooltip('t', 1, 1)
  vi.advanceTimersByTime(100)
  hideTooltip()
  vi.advanceTimersByTime(500)
  assert.equal(st.value.visible, false)
})
