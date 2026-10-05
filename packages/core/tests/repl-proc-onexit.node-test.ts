// [repl-proc-onexit-v1] onExit 契约守卫：回调须拿到真实 (code, signal)。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runReplProcess } from '../src/process/repl-proc.js'

test('正常退出：onExit 收到 (0, null)', async () => {
  const h = runReplProcess(process.execPath, { args: ['-e', '0'] })
  const got = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
    h.onExit((code, signal) => res([code, signal]))
  })
  console.log(`EXIT_OK=${JSON.stringify(got)}`)
  assert.equal(got[0], 0)
  assert.equal(got[1], null)
})

test('SIGKILL：onExit 收到 (null, SIGKILL)', async () => {
  const h = runReplProcess(process.execPath, { args: ['-e', 'setTimeout(()=>{},60000)'] })
  await new Promise(r => setTimeout(r, 300))
  h.kill('SIGKILL')
  const got = await new Promise<[number | null, NodeJS.Signals | null]>((res) => {
    h.onExit((code, signal) => res([code, signal]))
  })
  console.log(`EXIT_KILL=${JSON.stringify(got)}`)
  assert.equal(got[0], null)
  assert.equal(got[1], 'SIGKILL')
})
