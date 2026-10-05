// [repl-degraded-v1] 会话崩溃降级守卫：进程死后不删表，标记 degraded。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { closeSession, createSession, getSession, isSessionDegraded } from '../src/process/session-manager.js'

test('子进程死后：会话仍在表中且 isSessionDegraded=true', async () => {
  const info = createSession('read-only')
  try {
    assert.equal(isSessionDegraded(info.sid), false, '新建会话不应是 degraded')
    const entry = getSession(info.sid)
    assert.ok(entry, '会话应在表中')
    entry.handle.kill('SIGKILL')
    await new Promise(r => setTimeout(r, 400))
    assert.equal(isSessionDegraded(info.sid), true, '进程死后应标记 degraded')
    assert.ok(getSession(info.sid), 'degraded 会话不得从表中删除')
  } finally {
    await closeSession(info.sid)
  }
})

test('不存在的 sid：isSessionDegraded 返回 false（不抛错）', () => {
  assert.equal(isSessionDegraded('no-such-sid'), false)
})
