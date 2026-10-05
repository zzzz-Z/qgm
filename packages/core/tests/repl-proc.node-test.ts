// [repl-proc-v1] 守卫：runReplProcess 帧往返（send / nextFrame）。
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { runReplProcess } from '../src/process/repl-proc.js'
import type { ReplHandle } from '../src/process/repl-proc.js'

const NL = String.fromCharCode(10)
const ECHO = [
  'process.stdin.setEncoding("utf8")',
  'let b = ""',
  'process.stdin.on("data", d => {',
  '  b += d',
  '  let i',
  `  while ((i = b.indexOf(${JSON.stringify(NL)})) >= 0) {`,
  '    const line = b.slice(0, i); b = b.slice(i + 1)',
  `    if (line.trim()) process.stdout.write(line + ${JSON.stringify(NL)})`,
  '  }',
  '})',
].join(NL)

const live: ReplHandle[] = []
afterEach(() => { for (const h of live.splice(0)) { try { h.kill('SIGKILL') } catch { /* 已退出 */ } } })

test('send 后 nextFrame 收到同帧', async () => {
  const h = runReplProcess(process.execPath, { args: ['-e', ECHO] })
  live.push(h)
  h.send({ n: 7 })
  const f = await h.nextFrame(5000)
  assert.equal(f.n, 7)
})
