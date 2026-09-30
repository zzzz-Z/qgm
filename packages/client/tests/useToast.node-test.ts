// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useToast.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useToast.node-test.ts 迁至 test/useToast.node-test.ts
import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH19-1-USE-TOAST

let mod: typeof import('../../../packages/client/composables/ui/useToast')
before(async () => {
  mod = await import('../../../packages/client/composables/ui/useToast')
})

beforeEach(() => {
  // AIRUNNER-BATCH21-6-MOVE-TIMERS: 移入 hook
  vi.useFakeTimers()
  // 清空队列：逐个 dismiss 所有可见 toast
  const snap = mod.useToast().toasts.value.slice()
  for (const t of snap) mod.dismissToast(t.id)
  // 丢弃挂起的 confirm
  if (mod.useToast().confirmState.value) mod.resolveConfirm(false)
  vi.useFakeTimers()
  vi.useFakeTimers()
})

test('useToast: 返回完整 API', () => {
  const r = mod.useToast()
  for (const k of ['toasts', 'confirmState', 'toast', 'dismissToast', 'confirmDialog', 'resolveConfirm'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('toast: 新消息推入 toasts', () => {
  const { toasts } = mod.useToast()
  mod.toast('hello', 'info')
  assert.equal(toasts.value.length, 1)
  assert.equal(toasts.value[0].msg, 'hello')
  assert.equal(toasts.value[0].type, 'info')
  assert.equal(toasts.value[0].icon, 'i')
})

test('toast: 不同 type 有不同 icon', () => {
  const { toasts } = mod.useToast()
  mod.toast('a', 'success')
  mod.toast('b', 'warn')
  mod.toast('c', 'error')
  assert.equal(toasts.value[0].icon, '✓')
  assert.equal(toasts.value[1].icon, '!')
  assert.equal(toasts.value[2].icon, '✗')
})

test('toast: id 单调递增', () => {
  const { toasts } = mod.useToast()
  mod.toast('a')
  mod.toast('b')
  assert.ok(toasts.value[1].id > toasts.value[0].id)
})

test('toast: 无 key 时两条同名消息独立存在', () => {
  const { toasts } = mod.useToast()
  mod.toast('same')
  mod.toast('same')
  assert.equal(toasts.value.length, 2)
})

test('toast: 相同 key 原地更新 msg 不新增', () => {
  const { toasts } = mod.useToast()
  mod.toast('first', 'info', 3200, { key: 'stream' })
  mod.toast('second', 'info', 3200, { key: 'stream' })
  assert.equal(toasts.value.length, 1)
  assert.equal(toasts.value[0].msg, 'second')
})

test('toast: 相同 key 更新时 type 与 icon 同步', () => {
  const { toasts } = mod.useToast()
  mod.toast('x', 'info', 3200, { key: 'k' })
  mod.toast('x', 'error', 3200, { key: 'k' })
  assert.equal(toasts.value[0].type, 'error')
  assert.equal(toasts.value[0].icon, '✗')
})

test('toast: 超出 MAX_VISIBLE=3 淘汰最旧', () => {
  const { toasts } = mod.useToast()
  mod.toast('t1')
  mod.toast('t2')
  mod.toast('t3')
  mod.toast('t4')
  assert.equal(toasts.value.length, 3)
  assert.equal(toasts.value[0].msg, 't2')
  assert.equal(toasts.value[2].msg, 't4')
})

test('toast: duration 到点自动移除', () => {
  const { toasts } = mod.useToast()
  mod.toast('temp', 'info', 1000)
  assert.equal(toasts.value.length, 1)
  vi.advanceTimersByTime(999)
  assert.equal(toasts.value.length, 1)
  vi.advanceTimersByTime(2)
  assert.equal(toasts.value.length, 0)
})

test('toast: 相同 key 更新会续期计时器', () => {
  const { toasts } = mod.useToast()
  mod.toast('v1', 'info', 1000, { key: 'k' })
  vi.advanceTimersByTime(800)
  mod.toast('v2', 'info', 1000, { key: 'k' })
  vi.advanceTimersByTime(800)
  // 如果没续期，此时应为 0；续期后仍在
  assert.equal(toasts.value.length, 1)
  assert.equal(toasts.value[0].msg, 'v2')
})

test('dismissToast: 按 id 移除', () => {
  const { toasts } = mod.useToast()
  mod.toast('a')
  mod.toast('b')
  const aId = toasts.value[0].id
  mod.dismissToast(aId)
  assert.equal(toasts.value.length, 1)
  assert.equal(toasts.value[0].msg, 'b')
})

test('dismissToast: 不存在的 id 无副作用', () => {
  const { toasts } = mod.useToast()
  mod.toast('a')
  mod.dismissToast(999999)
  assert.equal(toasts.value.length, 1)
})

test('confirmDialog: 初始 confirmState 为 null', () => {
  assert.equal(mod.useToast().confirmState.value, null)
})

test('confirmDialog: 返回 Promise 并设置 confirmState', () => {
  const p = mod.confirmDialog('确定？')
  const cs = mod.useToast().confirmState.value
  assert.ok(cs)
  assert.equal(cs.msg, '确定？')
  assert.equal(cs.okText, '确认')
  assert.equal(cs.cancelText, '取消')
  assert.equal(cs.danger, false)
  assert.equal(cs.icon, '?')
  mod.resolveConfirm(false)
  void p
})

test('confirmDialog: type=danger → danger=true, icon=!', () => {
  const p = mod.confirmDialog('删？', { type: 'danger' })
  const cs = mod.useToast().confirmState.value!
  assert.equal(cs.danger, true)
  assert.equal(cs.icon, '!')
  mod.resolveConfirm(false)
  void p
})

test('confirmDialog: 自定义 okText / cancelText', () => {
  const p = mod.confirmDialog('m', { okText: '好', cancelText: '不' })
  const cs = mod.useToast().confirmState.value!
  assert.equal(cs.okText, '好')
  assert.equal(cs.cancelText, '不')
  mod.resolveConfirm(false)
  void p
})

test('confirmDialog: resolveConfirm(true) 兑现为 true', async () => {
  const p = mod.confirmDialog('q')
  mod.resolveConfirm(true)
  assert.equal(await p, true)
  assert.equal(mod.useToast().confirmState.value, null)
})

test('confirmDialog: resolveConfirm(false) 兑现为 false', async () => {
  const p = mod.confirmDialog('q')
  mod.resolveConfirm(false)
  assert.equal(await p, false)
})

test('confirmDialog: 二次调用使前一次立即 resolve(false)', async () => {
  const p1 = mod.confirmDialog('q1')
  const p2 = mod.confirmDialog('q2')
  assert.equal(await p1, false)
  mod.resolveConfirm(true)
  assert.equal(await p2, true)
})

test('resolveConfirm: 无挂起 confirm 时安全返回', () => {
  assert.equal(mod.useToast().confirmState.value, null)
  mod.resolveConfirm(true)
  assert.equal(mod.useToast().confirmState.value, null)
})
