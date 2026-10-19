// [subagent-orchestrator-v1] 子智能体编排器承重守卫。
// @why 判据承重：每条在编排逻辑退化（状态机失效、并发失控、结果协议被绕过）时都会变红。
import { expect, test } from 'vitest'
import { createSubagentOrchestrator } from '../src/subagent/orchestrator.js'
import type { SubagentResult, TaskExecutor } from '../src/subagent/orchestrator.js'

/** 测试用执行体：不依赖会话，立即返回固定结果。 */
function fakeExecutor(delayMs = 0, fail = false): TaskExecutor {
  return {
    kind: 'repl-script',
    async run(task): Promise<SubagentResult> {
      if (delayMs) await new Promise(r => setTimeout(r, delayMs))
      if (fail) throw new Error('boom')
      return { summary: `done:${task.description}`, artifacts: [] }
    },
  }
}

test('O1 提交后立即返回 pending，异步执行后变 done', async () => {
  const o = createSubagentOrchestrator([fakeExecutor(50)])
  const t = o.submit({ description: 'x' })
  expect(t.status).toBe('pending')
  await new Promise(r => setTimeout(r, 200))
  const snap = o.get(t.id)
  expect(snap?.status).toBe('done')
  expect(snap?.result?.summary).toBe('done:x')
})

test('O2 执行体抛错 → failed 且记录 error', async () => {
  const o = createSubagentOrchestrator([fakeExecutor(0, true)])
  const t = o.submit({ description: 'y' })
  await new Promise(r => setTimeout(r, 150))
  const snap = o.get(t.id)
  expect(snap?.status).toBe('failed')
  expect(snap?.error).toContain('boom')
})

test('O3 并发上限生效：3 个任务 maxConcurrent=2 时第三个必须等待', async () => {
  const o = createSubagentOrchestrator([fakeExecutor(150)], { maxConcurrent: 2 })
  const a = o.submit({ description: 'a' })
  const b = o.submit({ description: 'b' })
  const c = o.submit({ description: 'c' })
  await new Promise(r => setTimeout(r, 80))
  const s = o.summary()
  expect(s.runningNow).toBeLessThanOrEqual(2)
  expect(s.running + s.pending).toBeGreaterThan(0)
  await new Promise(r => setTimeout(r, 700))
  expect(o.get(a.id)?.status).toBe('done')
  expect(o.get(b.id)?.status).toBe('done')
  expect(o.get(c.id)?.status).toBe('done')
})

test('O4 取消运行中任务 → cancelled', async () => {
  const o = createSubagentOrchestrator([fakeExecutor(300)])
  const t = o.submit({ description: 'z' })
  await new Promise(r => setTimeout(r, 50))
  expect(o.cancel(t.id)).toBe(true)
  await new Promise(r => setTimeout(r, 400))
  expect(o.get(t.id)?.status).toBe('cancelled')
})

test('O5 summary 计数与 list 过滤一致', async () => {
  const o = createSubagentOrchestrator([fakeExecutor(0)])
  o.submit({ description: 'p' })
  await new Promise(r => setTimeout(r, 100))
  const s = o.summary()
  expect(s.total).toBe(1)
  expect(s.done).toBe(1)
  expect(o.list('done').length).toBe(1)
  expect(o.list('pending').length).toBe(0)
})

test('O6 未知执行体 → failed 且不崩', async () => {
  const o = createSubagentOrchestrator([])
  const t = o.submit({ description: 'q' })
  await new Promise(r => setTimeout(r, 50))
  expect(o.get(t.id)?.status).toBe('failed')
  expect(o.get(t.id)?.error).toContain('unknown executor')
})
