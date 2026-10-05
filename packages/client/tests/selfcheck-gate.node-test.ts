// [selfcheck-gate-test-v1] 期一自检闸 G1-G3
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { createReplyHandlers } from '../composables/ai/auto-loop/reply-handlers.js'
import { ref } from 'vue'

function makeInst() {
  return {
    state: ref('waiting'),
    id: ref('loop-1'),
    sessionId: ref('s1'),
    round: ref(1),
    goal: ref('g'),
    startCommit: ref('c'),
    stopRequest: ref('none'),
    stopReason: ref(''),
    lastHash: ref(''),
    lastExec: ref(null),
    waitingStartedAt: ref(0),
    waitingElapsed: ref(0),
    roundTimeoutMs: ref(90000),
    pendingRound: ref(null),
    roundTimer: null,
    waitingTicker: null,
    handoffTimer: null,
  } as any
}

const calls: Record<string, any[]> = { finish: [], sendFill: [], enterWaiting: [], runHook: [] }
let hookAction: 'ok' | 'reject' = 'ok'
let inst: any = null

function makeDeps() {
  return {
    loopPaused: ref(false),
    stage: ref(''),
    planResumeAttempts: ref(0),
    PLAN_RESUME_MAX: 3,
    transport: { sendFill: () => { calls.sendFill.push(1); return true }, sendStop: () => {} } as any,
    toast: () => {},
    ackFill: () => {},
    afterRound: async () => {},
    finish: async (i: any, r: string) => { calls.finish.push({ loopId: i.id.value, reason: r }) },
    handleStopAfterRound: async () => {},
    enterWaiting: () => { calls.enterWaiting.push(1) },
    disarmTimer: () => {},
    bindKeyboard: () => {},
    runHook: async (e: string, pl: any) => {
      calls.runHook.push({ event: e, payload: pl })
      return hookAction === 'reject' ? { event: e, action: 'reject', reason: 'test-fail', hooksRun: 1 } : { event: e, action: 'ok', hooksRun: 0 }
    },
    runBash: async () => ({} as any),
    useRunner: (() => ({})) as any,
    persist: () => {},
    isStrictDone: () => true,
    buildRetryPrompt: () => 'retry',
    pushTerminalNotice: () => {},
    resolveInst: () => inst,
    isInstActive: () => true,
  } as any
}

beforeEach(() => {
  calls.finish = []; calls.sendFill = []; calls.enterWaiting = []; calls.runHook = []
  hookAction = 'ok'
  inst = makeInst()
})

// [selfcheck-gate-test-v2] 期二：DONE 走 `BeforeDoneFinal`（服务端据台账决定跑全量 L2 还是只 L0+L1）
//   —— 期一断言 `BeforeDone` 已失效（B 交付期二时未同步本测试，被 L2 全量门当场抓出，实测 2026-10-05）
test('G1: DONE 前必须调用自检闸 hook（BeforeDoneFinal + final:true）', async () => {
  const deps = makeDeps()
  const h = createReplyHandlers(deps)
  await h.onNonScriptReply({ kind: 'done', text: 'DONE' }, 's1')
  const pre = calls.runHook.find((c: any) => c.event === 'BeforeDoneFinal')
  assert.ok(pre, 'BeforeDoneFinal 未被调用')
  assert.equal(pre.payload.loopId, 'loop-1')
  assert.equal(pre.payload.final, true, '终验轮必须带 final:true（服务端据此判定是否跑 L2 全量）')
})

test('G2: BeforeDone reject 不 finish，走 FEEDBACK + enterWaiting', async () => {
  hookAction = 'reject'
  const deps = makeDeps()
  const h = createReplyHandlers(deps)
  await h.onNonScriptReply({ kind: 'done', text: 'DONE' }, 's1')
  assert.equal(calls.finish.length, 0, 'reject 不应 finish')
  assert.equal(calls.sendFill.length, 1, '应回传失败报告')
  assert.equal(calls.enterWaiting.length, 1, '应回 waiting 续命')
})

test('G3: 连续 2 次 reject 触发 finish(selfcheck-failed)', async () => {
  hookAction = 'reject'
  const deps = makeDeps()
  const h = createReplyHandlers(deps)
  await h.onNonScriptReply({ kind: 'done', text: 'DONE' }, 's1')
  await h.onNonScriptReply({ kind: 'done', text: 'DONE' }, 's1')
  const hit = calls.finish.find((f: any) => f.reason === 'selfcheck-failed')
  assert.ok(hit, '第二次 reject 应触发熔断 finish')
})
