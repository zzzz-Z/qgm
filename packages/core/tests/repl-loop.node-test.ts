// [repl-loop-v1] 状态保留守卫。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runReplProcess } from '../src/process/repl-proc.js'

test('两帧后顶层变量保留', async () => {
  const h = runReplProcess(process.execPath, { args: ['packages/core/src/repl-loop.cjs'], cwd: process.cwd() })
  h.send({ id: 'f1', code: 'globalThis.__acc = 100' })
  const r1 = await h.nextFrame(5000)
  assert.equal(r1.id, 'f1')
  h.send({ id: 'f2', code: 'globalThis.__acc += 23' })
  const r2 = await h.nextFrame(5000)
  assert.equal(r2.id, 'f2')
  h.kill('SIGKILL')
})
