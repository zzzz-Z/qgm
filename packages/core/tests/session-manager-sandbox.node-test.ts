// [repl-session-sandbox-v1] 会话进程必须预加载沙箱拦截器 + 每帧 flush overlay。
// [WHY] 只传 AI_RUNNER_SANDBOX 不生效：拦截器没被 -r 加载 ⇒ read-only 形同虚设，
//   且 repl-loop 每帧调用的 __AI_FLUSH_OVERLAY 从未注册（帧末 flush 静默变空操作）。
// [CONSTRAINT] 断言必须落在「磁盘真实状态」上：拦截后的语义是「进 overlay，不落盘」。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { getRoot } from '../src/config.js'
import { closeSession, createSession, getSession } from '../src/process/session-manager.js'

test('read-only 会话：写盘被重定向进 overlay（不落盘），且帧末 flush 出 overlay 文件', async () => {
  const info = createSession('read-only')
  try {
    assert.ok(info.overlay, 'createSession 应返回 overlay 路径')
    const target = path.join(getRoot(), '.ai-runner', 'tmp', `guard-readonly-${info.sid}.txt`)
    const h = getSession(info.sid)?.handle
    assert.ok(h, 'createSession 后应能按 sid 取回会话')
    h.send({ id: 'w', code: `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')` })
    const frame = await h.nextFrame(5000)
    assert.equal(frame.ok, true, `帧应成功（写被重定向而非抛错）：${JSON.stringify(frame)}`)
    assert.equal(fs.existsSync(target), false, 'read-only 会话不得真的落盘')
    const ov = JSON.parse(fs.readFileSync(info.overlay, 'utf8')) as Record<string, unknown>
    assert.ok(Object.keys(ov).includes(path.resolve(target)), `overlay 未记录该写入：${JSON.stringify(Object.keys(ov))}`)
  } finally {
    await closeSession(info.sid)
  }
})

test('workspace-write 会话：越界写被拒（帧内报错，磁盘无残留）', async () => {
  const outside = path.join(getRoot(), '..', `airunner-guard-outside-${process.pid}.txt`)
  const info = createSession('workspace-write')
  try {
    const h = getSession(info.sid)?.handle
    assert.ok(h)
    h.send({ id: 'x', code: `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'x')` })
    const frame = await h.nextFrame(5000)
    assert.equal(frame.ok, false, `越界写应被拦：${JSON.stringify(frame)}`)
    assert.equal(fs.existsSync(outside), false, '越界文件不得存在')
  } finally {
    await closeSession(info.sid)
    try { fs.unlinkSync(outside) } catch { /* 期望就不存在 */ }
  }
})

test('closeSession 清理 overlay/toolLog 落盘文件', async () => {
  const info = createSession('read-only')
  const h = getSession(info.sid)?.handle
  assert.ok(h)
  h.send({ id: 'k', code: '1' })
  await h.nextFrame(5000)
  assert.ok(fs.existsSync(info.overlay), '至少一帧后 overlay 应已落盘')
  assert.equal(await closeSession(info.sid), true)
  assert.equal(fs.existsSync(info.overlay), false)
  assert.equal(fs.existsSync(info.toolLog), false)
  assert.equal(await closeSession(info.sid), false, '重复关闭应为 false')
})
