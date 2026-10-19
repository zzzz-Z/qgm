// [repl-async-frame-v1] REPL 异步帧支持承重守卫。
// @why 判据承重：每条在「await Promise 后再 emit」被移除、串行被破坏、同步脚本被引入延迟时都会变红。
import { expect, test } from 'vitest'
import { closeSession, createSession, getSession } from '../src/process/session-manager.js'

test('N1 异步脚本 await 后结果能进 logs', async () => {
  const info = createSession('workspace-write')
  const e = getSession(info.sid)!
  e.handle.send({ id: 'a1', code: ';\n(async () => {\n  await new Promise(r => setTimeout(r, 150))\n  __AI__.ok(JSON.stringify({ async: true, n: 7 }))\n})()' })
  const f = await e.handle.nextFrame(15000) as any
  expect(f.ok).toBe(true)
  expect(JSON.stringify(f.logs)).toContain('7')
  await closeSession(info.sid)
}, 20000)

test('N2 异步抛错被捕获为 ok:false 而非卡死', async () => {
  const info = createSession('workspace-write')
  const e = getSession(info.sid)!
  e.handle.send({ id: 'a2', code: 'Promise.reject(new Error("async-boom"))' })
  const f = await e.handle.nextFrame(15000) as any
  expect(f.ok).toBe(false)
  expect(String(f.error)).toContain('async-boom')
  await closeSession(info.sid)
}, 20000)

test('N3 同步脚本行为不变且不引入额外延迟', async () => {
  const info = createSession('workspace-write')
  const e = getSession(info.sid)!
  const t0 = Date.now()
  e.handle.send({ id: 's1', code: `__AI__.ok(${String.fromCharCode(34)}sync-ok${String.fromCharCode(34)})` })
  const f = await e.handle.nextFrame(15000) as any
  const dt = Date.now() - t0
  expect(f.ok).toBe(true)
  expect(JSON.stringify(f.logs)).toContain('sync-ok')
  expect(dt).toBeLessThan(5000)
  await closeSession(info.sid)
}, 20000)

test('N4 两帧连发保持顺序且 logs 不混淆', async () => {
  const info = createSession('workspace-write')
  const e = getSession(info.sid)!
  e.handle.send({ id: 'f1', code: `__AI__.ok(${String.fromCharCode(34)}one${String.fromCharCode(34)})` })
  e.handle.send({ id: 'f2', code: `__AI__.ok(${String.fromCharCode(34)}two${String.fromCharCode(34)})` })
  const a = await e.handle.nextFrame(15000) as any
  const b = await e.handle.nextFrame(15000) as any
  expect(a.id).toBe('f1')
  expect(b.id).toBe('f2')
  expect(JSON.stringify(a.logs)).toContain('one')
  expect(JSON.stringify(b.logs)).toContain('two')
  await closeSession(info.sid)
}, 20000)
