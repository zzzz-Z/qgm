// [subagent-fanout-v1] 完整编排范式：父任务拆解 → 并发派发 → 汇总。
// 跑法：npx vitest run packages/core/tests/subagent-fanout.node-test.ts
import { expect, test } from 'vitest'
import { createSubagentOrchestrator } from '../src/subagent/orchestrator.js'
import { defaultExecutors } from '../src/subagent/executors.js'

test('FANOUT 父任务拆三个子任务并发执行并汇总', async () => {
  const o = createSubagentOrchestrator(defaultExecutors, { maxConcurrent: 3 })
  const subtasks = [
    { name: 'count', desc: `const fs = require('node:fs')\nconst n = fs.readFileSync('packages/core/src/repl-loop.cjs', 'utf8').split(String.fromCharCode(10)).length\nreturn { summary: 'lines=' + n, artifacts: [] }` },
    { name: 'math', desc: `await new Promise(r => setTimeout(r, 150))\nreturn { summary: 'answer=' + (6 * 7), artifacts: [] }` },
    { name: 'probe', desc: `const fs = require('node:fs')\nreturn { summary: 'state=' + fs.existsSync('.ai-runner/state.json'), artifacts: [] }` },
  ]
  const launched = subtasks.map(s => ({ name: s.name, task: o.submit({ description: s.desc }) }))
  for (let i = 0; i < 100; i++) {
    const all = o.list()
    if (all.every(t => ['done', 'failed', 'cancelled'].includes(t.status))) break
    await new Promise(r => setTimeout(r, 200))
  }
  const results = launched.map(x => ({ name: x.name, status: o.get(x.task.id)?.status, summary: o.get(x.task.id)?.result?.summary }))
  console.log(`FANOUT_RESULTS=${JSON.stringify(results)}`)
  expect(o.summary().done).toBe(3)
}, 60000)
