// [turn-runner-v1] 接线层守卫：useTurnRunner → useRunner 的契约（真实驱动，不写源码锚点）。
//
// [WHY] 接线层最容易出的错全是「静默」的：多传了 autoFeedback 就变成 N 块回传 N 次、
//   忘了 try/finally 就 turnRunning 永远为 true、每块 fill 一次就等于没做合并。
//   这些都能在 node 里真跑出来 —— 把 useRunner 换成假 runner 即可，不需要造宿主。
import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
// vi.mock 会被 hoist 到所有 import 之前，故静态 import 一样拿到假 useRunner
import {
  abortAllTurns,
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

// [runtime-kind-ssot-v1] useRuntime 是跨组件单例且真实模块会碰 transport / storage；
//   这里替身化以便真跑接线并断言阶段转移（同 task-progress-panel.node-test.ts 的做法）。
const rt = vi.hoisted(() => ({ state: { value: { kind: 'idle' as string } } }))

vi.mock('../composables/ai/useRuntime', () => ({
  useRuntime: () => ({
    state: rt.state,
    enterExecuting: () => { rt.state.value.kind = 'executing' },
    enterFeedback: () => { rt.state.value.kind = 'feedback' },
    enterWaiting: () => { rt.state.value.kind = 'waiting' },
    settleIdle: () => { rt.state.value.kind = 'idle' },
    stop: () => { rt.state.value.kind = 'stopped' },
    reset: () => { rt.state.value.kind = 'idle' },
  }),
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
  rt.state.value.kind = 'idle'
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

// [turn-feedback-result-v1] 只 try/catch 吞掉投递结果的话，`failed` 会让这一轮结果永久丢失、
//   且界面无提示（filledTurns 已置位 ⇒ 之后不再重发）。判据：失败必须回滚去重位。
test('fill 返回 \'failed\' ⇒ 回滚去重位，同 turn 再进入会重发（脚本不重跑）', async () => {
  h.scripted.push(ok('x'))
  let calls = 0
  setTurnFillSink(() => { calls += 1; return 'failed' })
  await submitTurn(20, blocks(1))
  assert.equal(calls, 1)
  await submitTurn(20, blocks(1))
  assert.equal(calls, 2, 'failed 后未回滚去重位：这一轮结果永久丢失且用户无任何提示')
  assert.equal(h.runCalls.length, 1, '回滚去重位不得导致脚本重跑（执行账本仍幂等）')
})

// [turn-feedback-epoch-v1] 3 秒静默窗是异步悬挂的：窗口内点停止 / 切工作区后，
//   该 turn 的回灌必须被 ctx.stillValid() 挡住，不得投进别处（用户实测切工作区后回传串到别处）。
test('ctx.stillValid：正常有效；abort 该 turn 后失效', async () => {
  h.scripted.push(ok())
  const ctxs: Array<() => boolean> = []
  setTurnFillSink((_t, ctx) => { ctxs.push(ctx.stillValid) })
  await submitTurn(21, blocks(1))
  assert.equal(ctxs.length, 1, 'sink 必须收到 ctx（生产 sink 靠它复检会话）')
  assert.equal(ctxs[0]!(), true)
  abortTurn(21)
  assert.equal(ctxs[0]!(), false, 'abort 后悬挂回传未被挡：点停止仍会回传')
})

test('ctx.stillValid：resetTurnRunner（切工作区）后旧 ctx 失效（纪元自增）', async () => {
  h.scripted.push(ok())
  const ctxs: Array<() => boolean> = []
  setTurnFillSink((_t, ctx) => { ctxs.push(ctx.stillValid) })
  await submitTurn(22, blocks(1))
  assert.equal(ctxs[0]!(), true)
  resetTurnRunner()
  assert.equal(ctxs[0]!(), false, '切 root 纪元未自增：悬挂回传会投进新工作区')
})

// ── [runtime-kind-ssot-v1] 运行态（useRuntime.kind）阶段转移 ──
//
// [WHY] 等待 banner / 任务看板此前读的是并行真相源（props.aiWaiting + delivering），
//   两处都不覆盖「脚本执行中」的真实阶段 ⇒ 界面状态落后于实际。执行器是本项目脚本阶段的唯一写入方，
//   这里逐条钉死它的写点，避免状态机再次退化成「无人写、只有人读」。

test('submitTurn：回传窗内为 feedback，出站后回到 waiting', async () => {
  h.scripted.push(ok())
  const seen: string[] = []
  setTurnFillSink(() => { seen.push(rt.state.value.kind); return undefined })
  await submitTurn(30, blocks(1))
  assert.deepEqual(seen, ['feedback'], '回传窗运行态应为 feedback（此前无任何写入方）')
  assert.equal(rt.state.value.kind, 'waiting', '回传出站后应回到「等待下一轮回复」')
})

test('submitTurn：fill:false 无待发 ⇒ 收口回 idle', async () => {
  h.scripted.push(ok())
  await submitTurn(31, blocks(1), { fill: false })
  assert.equal(rt.state.value.kind, 'idle', '无回传通道时不得把运行态挂在 executing/feedback')
})

test('无 script 块不触碰运行态（总结轮不驱动执行）', async () => {
  rt.state.value.kind = 'waiting'
  await submitTurn(32, [{ type: 'say', id: 's1', text: 'done' }])
  assert.equal(rt.state.value.kind, 'waiting', '无执行块时不应改写运行态')
})

test('abortAllTurns ⇒ stopped；resetTurnRunner ⇒ idle', () => {
  rt.state.value.kind = 'waiting'
  abortAllTurns()
  assert.equal(rt.state.value.kind, 'stopped', '用户停止后运行态须为 stopped（不得自己变回 idle）')
  resetTurnRunner()
  assert.equal(rt.state.value.kind, 'idle', '切 root 后运行态必须归零，否则 stale kind 会继续误导 UI')
})
