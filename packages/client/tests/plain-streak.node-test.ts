// [plain-streak-v1-test] P0：plain 分支自动续跑 + 熔断判据
// 判据：P1 一次 plain 续跑不终止；P2 连续 N 次熔断；P3 收到脚本清零；P4 sendFill 失败不计数
import { beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { _plainStreak, createReplyHandlers, isFrozenBroadcast } from '../composables/ai/auto-loop/reply-handlers.js'

function makeInst() {
  return {
    state: ref('waiting'),
    id: ref('loop-plain'),
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

const calls: Record<string, any[]> = { finish: [], sendFill: [], enterWaiting: [] }
let inst: any = null
let sendFillOk = true

function makeDeps() {
  return {
    loopPaused: ref(false),
    stage: ref(''),
    planResumeAttempts: ref(0),
    PLAN_RESUME_MAX: 3,
    transport: { sendFill: () => { calls.sendFill.push(1); return sendFillOk }, sendStop: () => {} } as any,
    toast: () => {},
    ackFill: () => {},
    afterRound: async () => {},
    finish: async (i: any, r: string) => { calls.finish.push({ loopId: i.id.value, reason: r }) },
    handleStopAfterRound: async () => {},
    enterWaiting: (i: any) => { calls.enterWaiting.push(1); i.state.value = 'waiting' },
    disarmTimer: () => {},
    bindKeyboard: () => {},
    runHook: async (e: string) => ({ event: e, action: 'ok', hooksRun: 0 }),
    runBash: async () => ({} as any),
    useRunner: (() => ({
      script: ref(''),
      run: async () => ({ code: 0, ok: true, stdout: '', stderr: '', breaker: false }),
      changes: ref([]),
    })) as any,
    persist: () => {},
    isStrictDone: () => true,
    buildRetryPrompt: () => 'retry',
    pushTerminalNotice: () => {},
    resolveInst: () => inst,
    isInstActive: () => true,
  } as any
}

beforeEach(() => {
  calls.finish = []; calls.sendFill = []; calls.enterWaiting = []
  sendFillOk = true
  _plainStreak.clear()
  inst = makeInst()
})

test('P1: 1 次 plain ⇒ 续跑（sendFill），不终止', async () => {
  const h = createReplyHandlers(makeDeps())
  await h.onNonScriptReply({ kind: 'plain', text: '一些说明' }, 's1')
  assert.equal(calls.sendFill.length, 1, '应发续跑 prompt')
  assert.equal(calls.finish.filter((f: any) => f.reason === 'no-script-reply').length, 0, '第一次不得熔断')
  assert.equal(calls.enterWaiting.length, 1, '应重新进入等待')
})

test('P2: 连续 PLAIN_STREAK_MAX 次 plain ⇒ finish(no-script-reply)', async () => {
  const h = createReplyHandlers(makeDeps())
  for (let i = 0; i < 2; i++) {
    await h.onNonScriptReply({ kind: 'plain', text: `第 ${i + 1} 次` }, 's1')
  }
  const hit = calls.finish.find((f: any) => f.reason === 'no-script-reply')
  assert.ok(hit, '连续 N 次 plain 应触发熔断')
  // [复检建议2] 熔断分支 return 在 sendFill 之前 ⇒ 第 2 次 plain 不得再发续跑 prompt
  assert.equal(calls.sendFill.length, 1, '第 2 次 plain 熔断前不得再发 sendFill（仅第 1 次续跑）')
})

test('P3: plain 后收到脚本 ⇒ streak 清零（再 plain 视为第 1 次）', async () => {
  const h = createReplyHandlers(makeDeps())
  await h.onNonScriptReply({ kind: 'plain', text: 'p1' }, 's1')
  assert.equal(calls.sendFill.length, 1)
  const item = { id: 'i1', code: '#!/usr/bin/env node\n// @desc x\n// @why y', lang: 'js', site: '', hash: 'h1', desc: 'x', why: 'y', ts: Date.now() }
  await h.onScriptArrival(item as any, 's1')
  // onScriptArrival 走完 executeItem（executeItemInner 正常路径会把计数清零）
  assert.equal(_plainStreak.get('loop-plain') ?? 0, 0, '收到脚本后计数应清零')
  // 手工把 state 回 waiting（executeItemInner 后停在 parsing/executing；生产中由 afterRound 推进）
  inst.state.value = 'waiting'
  calls.finish = []; calls.sendFill = []
  await h.onNonScriptReply({ kind: 'plain', text: 'p2' }, 's1')
  assert.equal(calls.finish.filter((f: any) => f.reason === 'no-script-reply').length, 0, '清零后首次 plain 不得熔断')
  assert.equal(calls.sendFill.length, 1)
})

test('P4: sendFill 失败 ⇒ 立即 finish(window-lost)，不计数', async () => {
  sendFillOk = false
  const h = createReplyHandlers(makeDeps())
  await h.onNonScriptReply({ kind: 'plain', text: 'p' }, 's1')
  const hit = calls.finish.find((f: any) => f.reason === 'window-lost')
  assert.ok(hit, 'sendFill 失败应走 window-lost')
  assert.equal(calls.finish.filter((f: any) => f.reason === 'no-script-reply').length, 0, '不计数不熔断')
  assert.equal(_plainStreak.get('loop-plain') ?? 0, 0, '失败路径不得写入计数')
})

test('P5: 冻结播报（含「已冻结」）豁免计数与熔断，但仍续跑', async () => {
  assert.equal(isFrozenBroadcast('已冻结：t1'), true, 'isFrozenBroadcast 应识别冻结播报')
  assert.equal(isFrozenBroadcast('普通文本'), false)
  const h = createReplyHandlers(makeDeps())
  for (let i = 0; i < 3; i++) {
    inst.state.value = 'waiting'
    await h.onNonScriptReply({ kind: 'plain', text: `已冻结：todo-${i + 1}` }, 's1')
  }
  assert.equal(calls.sendFill.length, 3, '冻结播报每次都续跑（不续跑则退回 90s 干等）')
  assert.equal(calls.finish.filter((f: any) => f.reason === 'no-script-reply').length, 0, '冻结播报不得触发熔断')
  assert.equal(_plainStreak.has('loop-plain'), false, '冻结播报不写入计数（has 区分「未写入」与「写入 0」，锁住第三层守卫）')
})
