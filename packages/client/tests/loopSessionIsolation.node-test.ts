// [session-isolation-v1] 守卫：pickInstanceBySessionId 的 sid 匹配矩阵。
// [WHY] 直接 import 生产函数（而非抄副本），任一规则被改坏立刻红。
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { singletonView } from '../composables/ai/auto-loop/state.js'
import { pickInstanceBySessionId } from '../composables/ai/auto-loop/session-isolation.js'

beforeEach(() => { singletonView.sessionId.value = '' })

test('双方 sid 相等 → 放行', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(pickInstanceBySessionId(singletonView, 'sess-A'), singletonView)
})

test('双方 sid 不等 → 拒绝（隔离核心）', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(pickInstanceBySessionId(singletonView, 'sess-B'), null)
})

test('inst 未绑定（bound 空）→ 放行（旧油猴兼容）', () => {
  singletonView.sessionId.value = ''
  assert.equal(pickInstanceBySessionId(singletonView, 'sess-A'), singletonView)
})

test('传入 sid 为空 → 放行（旧油猴兼容）', () => {
  singletonView.sessionId.value = 'sess-A'
  assert.equal(pickInstanceBySessionId(singletonView, ''), singletonView)
})

test('inst 为 null → 返回 null（不抛错）', () => {
  assert.equal(pickInstanceBySessionId(null, 'sess-X'), null)
})

test('singletonView 必须含 sessionId 且可写', () => {
  assert.ok(singletonView.sessionId)
  singletonView.sessionId.value = 'probe'
  assert.equal(singletonView.sessionId.value, 'probe')
})
