// [board-reconcile-v1] WO-20261007-01 承重判据：
//   段一口径 —— 删桶采样必须读 bucketItems（落盘主存储），读 readTaskState 会并入 PLAN.md 派生项。
//   段二来源 —— clear='finish' 才计入指标，'init' 稀释分母。
//   顺序 —— 采样在删桶前（同函数同请求，结构保证）。
import { afterEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitTaskState, mutateTaskState, taskId } from '../src/state/task-store.js'
import { getRoot, setRoot } from '../src/config.js'

const ORIG = getRoot()
afterEach(() => { setRoot(ORIG) })

function withRoot(state: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'))
  fs.mkdirSync(path.join(dir, '.ai-runner'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.ai-runner', 'state.json'), JSON.stringify(state, null, 2))
  setRoot(dir)
  return dir
}

test('段一正向：删桶前采样 pending/running 数（3 push 1 complete ⇒ 2 未收口）', () => {
  withRoot({ round: 1, status: 'running', version: 1, tasksBySid: { s1: { items: [
    { id: taskId('A'), desc: 'A', status: 'done', createdAt: 1, doneAt: 2 },
    { id: taskId('B'), desc: 'B', status: 'pending', createdAt: 1 },
    { id: taskId('C'), desc: 'C', status: 'running', createdAt: 1, startedAt: Date.now() },
  ], updatedAt: Date.now() } } })
  const out = mutateTaskState('s1', { mode: 'set', todo: [], done: [] })
  assert.ok(out.cleared, 'cleared 缺失')
  assert.equal(out.cleared.count, 2)
  assert.deepEqual(out.cleared.keys.sort(), ['B', 'C'])
})

test('段一口径：只读 bucketItems，PLAN.md 派生项不计入（防空转）', () => {
  // [承重关键] 必须造 PLAN.md：无它时 readTaskState 与 bucketItems 结果相同，判据无法区分。
  //   PLAN 项 done:false ⇒ readTaskState 合并后出现 pending ⇒ 误读版本 count 变 1。
  const dir = withRoot({ round: 1, status: 'running', version: 1, tasksBySid: { s1: { items: [], updatedAt: Date.now() } } })
  fs.writeFileSync(path.join(dir, 'PLAN.md'), '## 二、待办\n\n- [ ] 来自 PLAN 的派生待办\n')
  const out = mutateTaskState('s1', { mode: 'set', todo: [], done: [] })
  assert.equal(out.cleared?.count ?? -1, 0, 'PLAN 派生项被计入 ⇒ 读的是 readTaskState 而非 bucketItems')
})

test('段一：非删桶（items 非空）不产 cleared 样本', () => {
  withRoot({ round: 1, status: 'running', version: 1, tasksBySid: {} })
  const out = mutateTaskState('s1', { mode: 'push', pushTodo: ['X'] })
  assert.equal(out.cleared, undefined)
})

test('段一：version 冲突重放不重复计数（只在 ok:true 采样）', () => {
  withRoot({ round: 1, status: 'running', version: 1, tasksBySid: { s1: { items: [{ id: taskId('A'), desc: 'A', status: 'pending', createdAt: 1 }], updatedAt: Date.now() } } })
  // 传错 version ⇒ commitTaskState 拒绝；mutateTaskState 内部重放后成功
  const res = commitTaskState({ round: 1, status: 'running', todo: [], done: [], items: [] }, 's1', 999)
  assert.equal(res.ok, false, 'version 不符应拒')
  assert.equal(res.cleared, undefined, '冲突路径不得产样本')
})
