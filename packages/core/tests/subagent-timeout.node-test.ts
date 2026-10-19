// [subagent-task-timeout-v1] 超时与取消响应承重守卫。
// @why 判据承重：超时计时器被删 / abort 竞速被删 / 清理被跳过时，对应断言必红。
import { expect, test } from 'vitest'
import { createSubagentOrchestrator } from '../src/subagent/orchestrator.js'
import type { TaskExecutor } from '../src/subagent/orchestrator.js'

/** 永不 resolve 的执行体：模拟卡死。 */
function hangingExecutor(): TaskExecutor {
  return {
    kind: 'repl-script',
    async run() { return new Promise(() => {}) },
  }
}

/** 忽略 signal 的执行体：验证编排层兜底而非依赖执行体配合。 */
function stubbornExecutor(ms: number): TaskExecutor {
  return {
    kind: 'repl-script',
    async run() { await new Promise(r => setTimeout(r, ms)); return { summary: 'late', artifacts: [] } },
  }
}

test('T1 任务整体超时被 abort 并标 failed', async () => {
  const o = createSubagentOrchestrator([hangingExecutor()], { taskTimeoutMs: 300 })
  const t = o.submit({ description: 'never' })
  let snap = o.get(t.id)
  for (let i = 0; i < 30 && snap?.status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 100))
    snap = o.get(t.id)
  }
  expect(snap?.status).toBe('failed')
  expect(String(snap?.error)).toContain('timeout')
}, 15000)

test('T2 超时后槽位被释放，后续任务可执行', async () => {
  const o = createSubagentOrchestrator([hangingExecutor()], { taskTimeoutMs: 300, maxConcurrent: 1 })
  const a = o.submit({ description: 'hang' })
  const b = o.submit({ description: 'also-hang' })
  let sa = o.get(a.id)
  for (let i = 0; i < 30 && sa?.status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 100))
    sa = o.get(a.id)
  }
  expect(sa?.status).toBe('failed')
  // 槽位释放后 b 才能拿到槽并开始（然后也超时失败）
  let sb = o.get(b.id)
  for (let i = 0; i < 40 && sb?.status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 100))
    sb = o.get(b.id)
  }
  expect(sb?.status, '槽位未释放会让 b 永久 pending').toBe('failed')
}, 20000)

test('T3 取消正在等待的任务立即生效（不等执行体配合）', async () => {
  const o = createSubagentOrchestrator([stubbornExecutor(10000)], { taskTimeoutMs: 60000 })
  const t = o.submit({ description: 'long' })
  await new Promise(r => setTimeout(r, 200))
  const t0 = Date.now()
  expect(o.cancel(t.id)).toBe(true)
  let snap = o.get(t.id)
  for (let i = 0; i < 20 && snap?.status !== 'cancelled'; i++) {
    await new Promise(r => setTimeout(r, 50))
    snap = o.get(t.id)
  }
  expect(snap?.status).toBe('cancelled')
  expect(Date.now() - t0, '取消应立即返回，不应等执行体跑完').toBeLessThan(3000)
}, 15000)
