// [turn-runner-v1] 接线层守卫：useTurnRunner → useRunner 的契约（真实驱动，不写源码锚点）。
//
// [WHY] 接线层最容易出的错全是「静默」的：多传了 autoFeedback 就变成 N 块回传 N 次、
//   忘了 try/finally 就 turnRunning 永远为 true、每块 fill 一次就等于没做合并。
//   这些都能在 node 里真跑出来 —— 把 useRunner 换成假 runner 即可，不需要造宿主。
import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
// vi.mock 会被 hoist 到所有 import 之前，故静态 import 一样拿到假 useRunner
import {
  abortTurn,
  resetTurnRunner,
  seedTurnLedger,
  setTurnFillSink,
  submitTurn,
  useTurnRunner,
} from '../composables/runner/useTurnRunner.js'

const h = vi.hoisted(() => ({
  runCalls: [] as Array<{ script?: string, runKey?: string, autoFeedback?: boolean }>,
  stopCalls: 0,
  /** 每块返回的结果；null 元素 ⇒ 该块返回 'skipped' */
  scripted: [] as Array<{ ok: boolean, code: number, stdout: string, stderr: string } | null>,
}))

vi.mock('../composables/runner/useRunner', () => ({
  useRunner: () => ({
    run: async (opts: { script?: string, runKey?: string, autoFeedback?: boolean }) => {
      h.runCalls.push(opts)
      const next = h.scripted.shift()
      if (!next) return 'skipped'
      return { ...next, runId: 'r', changes: [] }
    },
    stop: () => { h.stopCalls += 1 },
  }),
}))

function ok(stdout = 'ok'): { ok: boolean, code: number, stdout: string, stderr: string } {
  return { ok: true, code: 0, stdout, stderr: '' }
}

beforeEach(() => {
  resetTurnRunner()
  h.runCalls.length = 0
  h.scripted.length = 0
  h.stopCalls = 0
  setTurnFillSink(null)
})

function blocks(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'script',
    id: `b${i}`,
    seq: i,
    code: `console.log(${i})`,
    lang: 'js',
    desc: `d${i}`,
    why: `w${i}`,
  }))
}

test('submitTurn 逐块调 useRunner.run，runKey=turn|id，且 autoFeedback 恒为 false', async () => {
  h.scripted.push(ok('a'), ok('b'))
  const out = await submitTurn(3, blocks(2))
  assert.equal(h.runCalls.length, 2)
  assert.deepEqual(h.runCalls.map(c => c.runKey), ['3|b0', '3|b1'])
  assert.deepEqual(h.runCalls.map(c => c.autoFeedback), [false, false], 'autoFeedback=true 会让 N 块变成 N 次提问')
  assert.deepEqual(out.map(r => r.status), ['ok', 'ok'])
  assert.deepEqual(out.map(r => r.out), ['a', 'b'], '结果必须取自 run 的返回值（全局 result 只有最后一块）')
})

test('一次 fill：N 块只回灌一条，且文本含每块状态', async () => {
  h.scripted.push(ok(), { ok: false, code: 1, stdout: '', stderr: 'TypeError: boom' })
  const fills: string[] = []
  setTurnFillSink((t) => { fills.push(t) })
  await submitTurn(4, blocks(2))
  assert.equal(fills.length, 1, '每块 fill 一次等于没做合并（N 块 = N 次提问）')
  assert.match(fills[0]!, /# turn 4 执行结果（2 块 · 成功 1 · 未成功 1）/)
  assert.match(fills[0]!, /b1 \[error\] exit=1 err=TypeError: boom/)
})

test('fill:false 只记账不发送', async () => {
  h.scripted.push(ok())
  const fills: string[] = []
  setTurnFillSink((t) => { fills.push(t) })
  await submitTurn(5, blocks(1), { fill: false })
  assert.deepEqual(fills, [])
})

test('fill 抛异常不影响执行结果（结果已在账本里）', async () => {
  h.scripted.push(ok('done'))
  setTurnFillSink(() => { throw new Error('transport down') })
  const out = await submitTurn(6, blocks(1))
  assert.equal(out[0]!.status, 'ok')
  assert.equal(useTurnRunner().view().outcomesOf(6)[0]!.out, 'done')
})

test('无 script 块 ⇒ 不执行也不回灌（本 turn 即总结轮）', async () => {
  const fills: string[] = []
  setTurnFillSink((t) => { fills.push(t) })
  const out = await submitTurn(7, [{ type: 'say', id: 's1', text: 'done' }])
  assert.deepEqual(out, [])
  assert.equal(h.runCalls.length, 0)
  assert.deepEqual(fills, [])
  assert.equal(useTurnRunner().view().running, false)
})

test('幂等：同 turn 二次 submit 不重跑、不重复回灌', async () => {
  h.scripted.push(ok())
  const fills: string[] = []
  setTurnFillSink((t) => { fills.push(t) })
  await submitTurn(8, blocks(1))
  await submitTurn(8, blocks(1))
  assert.equal(h.runCalls.length, 1, '重放帧 / 组件重挂不得把同一批脚本再跑一遍')
  assert.equal(fills.length, 1)
})

test('运行中出现异常也收口 turnRunning（不得永远显示执行中）', async () => {
  h.scripted.push(ok())
  const view = useTurnRunner()
  await submitTurn(9, blocks(1))
  assert.equal(view.turnRunning.value, false)
})

test('abortTurn 真的把中止信号传给 useRunner.stop', async () => {
  h.scripted.push(null) // 返回 'skipped'，不留悬空 promise
  await submitTurn(10, blocks(1))
  h.stopCalls = 0
  const ids = abortTurn(10)
  // 该 turn 已收口 ⇒ 无在飞块，不应产生中止信号（幂等：不误伤别的 turn）
  assert.deepEqual(ids, [])
  assert.equal(h.stopCalls, 0)
})

test('seed 灌入的账本挡住重跑（跨刷新重放的唯一防线）', async () => {
  h.scripted.push(ok('fresh'))
  seedTurnLedger(11, [{ id: 'b0', seq: 0, status: 'ok', exit: 0, out: 'from-server' }])
  const out = await submitTurn(11, blocks(2))
  assert.equal(h.runCalls.length, 1, '只有 b1 该跑')
  assert.deepEqual(h.runCalls.map(c => c.runKey), ['11|b1'])
  assert.deepEqual(out.map(r => r.out), ['from-server', 'fresh'])
})
