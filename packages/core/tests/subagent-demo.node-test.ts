// [subagent-demo-v1] 子任务编排端到端演示：一个父任务拆成三个子任务并发执行，汇总结果。
// 用法：npx vitest run packages/core/tests/subagent-demo.node-test.ts
import { expect, test } from 'vitest'
import { createSubagentOrchestrator } from '../src/subagent/orchestrator.js'
import { defaultExecutors } from '../src/subagent/executors.js'

test('DEMO 父任务拆三个子任务并发执行并汇总', async () => {
  const o = createSubagentOrchestrator(defaultExecutors, { maxConcurrent: 3 })

  // 模拟「父任务拆解」：三个独立的子任务描述
  const subtasks = [
    { name: '统计行数', code: `
      const fs = require('node:fs')
      const n = fs.readFileSync('packages/core/src/repl-loop.cjs', 'utf8').split(String.fromCharCode(10)).length
      return { summary: 'repl-loop.cjs 共 ' + n + ' 行', artifacts: [] }
    ` },
    { name: '异步计算', code: `
      await new Promise(r => setTimeout(r, 200))
      return { summary: '异步任务完成，结果 ' + (6 * 7), artifacts: [] }
    ` },
    { name: '读状态', code: `
      const fs = require('node:fs')
      const ok = fs.existsSync('.ai-runner/state.json')
      return { summary: 'state.json 存在=' + ok, artifacts: [] }
    ` },
  ]

  const submitted = subtasks.map(s => ({ name: s.name, task: o.submit({ description: s.code }) }))
  console.log(`提交后 summary=${JSON.stringify(o.summary())}`)
  expect(submitted.every(s => s.task.status === 'pending')).toBe(true)

  // 轮询等待全部终态
  let all = o.list()
  for (let i = 0; i < 100 && all.some(t => t.status === 'pending' || t.status === 'running'); i++) {
    await new Promise(r => setTimeout(r, 200))
    all = o.list()
  }

  const summary = o.summary()
  console.log(`最终 summary=${JSON.stringify(summary)}`)
  for (const s of submitted) {
    const snap = o.get(s.task.id)
    console.log(`[${s.name}] status=${snap?.status} summary=${snap?.result?.summary || snap?.error}`)
  }

  expect(summary.done, '三个子任务都应完成').toBe(3)
  const texts = submitted.map(s => o.get(s.task.id)?.result?.summary || '')
  expect(texts[0]).toContain('行')
  expect(texts[1]).toContain('42')
  expect(texts[2]).toContain('state.json')
}, 60000)
