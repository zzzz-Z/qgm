// [repl-idle-reclaim-v1] 空闲回收守卫：超阈回收（连带 overlay 清理）/ 活会话不误杀。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { closeSession, createSession, getSession, reclaimIdleSessions, touchSession } from '../src/process/session-manager.js'

test('超阈会话被回收；活会话不受影响', async () => {
  const stale = createSession('read-only')
  const fresh = createSession('read-only')
  try {
    const se = getSession(stale.sid)
    assert.ok(se)
    se.lastActiveAt = Date.now() - 11 * 60 * 1000
    const r = await reclaimIdleSessions()
    assert.ok(r.includes(stale.sid), `超阈应被回收: ${JSON.stringify(r)}`)
    assert.equal(getSession(stale.sid), null, '回收后应从表中移除')
    assert.ok(getSession(fresh.sid), '活会话不得被误杀')
  } finally {
    await closeSession(stale.sid)
    await closeSession(fresh.sid)
  }
})

test('touchSession 刷新后不再被回收', async () => {
  const info = createSession('read-only')
  try {
    const e = getSession(info.sid)
    assert.ok(e)
    e.lastActiveAt = Date.now() - 11 * 60 * 1000
    touchSession(info.sid)
    const r = await reclaimIdleSessions()
    assert.ok(!r.includes(info.sid), 'touch 后不应被回收')
  } finally {
    await closeSession(info.sid)
  }
})

test('回收时连带清理 overlay 落盘文件', async () => {
  const info = createSession('read-only')
  const e = getSession(info.sid)
  assert.ok(e)
  e.handle.send({ id: 'w', code: '1' })
  await e.handle.nextFrame(5000)
  assert.ok(fs.existsSync(info.overlay), '至少一帧后 overlay 应已落盘')
  e.lastActiveAt = Date.now() - 11 * 60 * 1000
  await reclaimIdleSessions()
  assert.equal(fs.existsSync(info.overlay), false, '回收应连带清理 overlay')
})
