// [repl-frame-channel-v1] 帧通道纯度守卫：一帧进、一帧出，用户输出不得串位。
// [WHY] 历史实现里 console.log 直写 stdout，其文本会被父进程 JSON.parse 成合法值当成帧投递，
//   使第 2 帧起「请求 : 响应」永久错位（S5 冒烟实测：f3 收到 f2 的 ack）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runReplProcess } from '../src/process/repl-proc.js'

const LOOP = 'packages/core/src/repl-loop.cjs'

/** 起一个裸 REPL（不挂拦截器，隔离帧通道本身） */
function boot() {
  return runReplProcess(process.execPath, { args: [LOOP], cwd: process.cwd() })
}

test('console.log 不串位：连发 4 帧逐帧 id 对齐', async () => {
  const h = boot()
  const steps = [
    { id: 'f1', code: 'globalThis.__x = 1', ok: true },
    { id: 'f2', code: 'console.log(globalThis.__x)', ok: true },
    { id: 'f3', code: 'throw new Error("boom")', ok: false },
    { id: 'f4', code: 'console.log(globalThis.__x * 10)', ok: true },
  ]
  for (const s of steps) {
    h.send({ id: s.id, code: s.code })
    const f = await h.nextFrame(5000)
    assert.equal(f.id, s.id, `帧错位：期望 ${s.id}，实得 ${JSON.stringify(f)}`)
    assert.equal(f.ok, s.ok)
  }
  h.kill('SIGKILL')
})

test('console.log 输出收进本帧 logs', async () => {
  const h = boot()
  h.send({ id: 'a', code: 'console.log(globalThis.__noSuchVar, "z")' })
  const f = await h.nextFrame(5000)
  assert.deepEqual(f.logs, ['undefined z'])
  h.kill('SIGKILL')
})

test('直写 process.stdout 也被收进 logs（不污染协议通道）', async () => {
  const h = boot()
  h.send({ id: 'w', code: 'process.stdout.write("raw")' })
  const f = await h.nextFrame(5000)
  assert.equal(f.id, 'w')
  assert.deepEqual(f.logs, ['raw'])
  h.kill('SIGKILL')
})

test('错误帧带 id，可按 id 关联', async () => {
  const h = boot()
  h.send({ id: 'err1', code: 'throw new Error("boom")' })
  const f = await h.nextFrame(5000)
  assert.equal(f.id, 'err1')
  assert.equal(f.ok, false)
  assert.equal(f.error, 'boom')
  h.kill('SIGKILL')
})

test('无输出的成功帧形状不变（不带 logs）', async () => {
  const h = boot()
  h.send({ id: 'q', code: '1 + 1' })
  const f = await h.nextFrame(5000)
  assert.deepEqual(f, { id: 'q', ok: true })
  h.kill('SIGKILL')
})
