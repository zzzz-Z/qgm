// [session-isolation-v1] 守卫：resolveInst(sid) 必须按 sid 路由，禁止恒返回单例。
// [WHY] 双窗口并发时 reply-handlers 经 resolveInst 分发事件；若恒返回单例，
//       B 窗回复会被投给 A 窗循环，双 sid 事件/回复串流（AGENDA-1 核心缺陷）。
// [CONSTRAINT] 直接 import useAutoLoop 的真实导出，禁止抄副本——
//      实现若回退为 activeLoop.value，本测试立即红。
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { resolveInst } from '../composables/ai/useAutoLoop.js'
import { singletonView } from '../composables/ai/auto-loop/state.js'

beforeEach(() => { singletonView.sessionId.value = '' })

test('双 sid 并发：inst 绑定 sess-A，收到 sess-B 回复 → 拒绝（隔离核心）', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(resolveInst('sess-B'), null)
})

test('同 sid：inst 绑定 sess-A，收到 sess-A 回复 → 放行', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(resolveInst('sess-A'), singletonView)
})

test('inst 未绑定（旧油猴）：inst 无 sessionId，收到 sess-A → 放行', () => {
  singletonView.sessionId.value = ''
  assert.equal(resolveInst('sess-A'), singletonView)
})

test('sid 为空（旧油猴）：inst 绑定 sess-A，收到空 sid → 放行', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(resolveInst(''), singletonView)
})

test('无参调用：等价于 sid 为空 → 放行', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(resolveInst(), singletonView)
})
