// [subagent-executors-v1] repl-script 执行体承重守卫。
// @why 判据承重：本条在「执行体真能起会话、跑脚本、经 logs 回收结果」被破坏时必红。
//   注：本测试真实创建/销毁 REPL 子进程，耗时较长，但这是唯一能证明执行体可用的方式。
import { expect, test } from 'vitest'
import { createSubagentOrchestrator } from '../src/subagent/orchestrator.js'
import { defaultExecutors } from '../src/subagent/executors.js'

test('X1 repl-script 执行体起会话跑脚本并经 logs 回摘要', async () => {
  const o = createSubagentOrchestrator(defaultExecutors, { maxConcurrent: 1 })
  const t = o.submit({ description: 'return { summary: "hello-from-subagent", artifacts: ["a.txt"] }' })
  let snap = o.get(t.id)
  for (let i = 0; i < 60 && snap?.status !== 'done' && snap?.status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 200))
    snap = o.get(t.id)
  }
  expect(snap?.status, `最终=${snap?.status} err=${snap?.error}`).toBe('done')
  expect(snap?.result?.summary).toContain('hello-from-subagent')
  expect(snap?.result?.artifacts).toContain('a.txt')
  expect(snap?.sessionId).toBeTruthy()
}, 40000)

test('X2 会话在任务完成后被清理（cleanup 生效）', async () => {
  const { getSession } = await import('../src/process/session-manager.js')
  const o = createSubagentOrchestrator(defaultExecutors, { maxConcurrent: 1 })
  const t = o.submit({ description: 'return { summary: "x", artifacts: [] }' })
  let snap = o.get(t.id)
  for (let i = 0; i < 60 && snap?.status !== 'done' && snap?.status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 200))
    snap = o.get(t.id)
  }
  expect(snap?.status).toBe('done')
  await new Promise(r => setTimeout(r, 300))
  expect(getSession(snap!.sessionId!), '任务完成后会话应已关闭').toBeNull()
}, 40000)

test('X3 异步任务（await）在执行体里真能跑通', async () => {
  const o = createSubagentOrchestrator(defaultExecutors, { maxConcurrent: 1 })
  const t = o.submit({ description: 'await new Promise(r => setTimeout(r, 150));\nreturn { summary: "async-done", artifacts: ["b"] }' })
  let snap = o.get(t.id)
  for (let i = 0; i < 80 && snap?.status !== 'done' && snap?.status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 200))
    snap = o.get(t.id)
  }
  expect(snap?.status, `最终=${snap?.status} err=${snap?.error}`).toBe('done')
  expect(snap?.result?.summary).toContain('async-done')
}, 40000)
