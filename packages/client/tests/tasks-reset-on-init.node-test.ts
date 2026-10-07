// @vitest-environment happy-dom
// [tasks-reset-on-init-v1] WO-20261006-03 段一：initLoop 成功路径清同 sid 桶。
//   判据承重：删清桶调用 ⇒ 本文件变红；清桶挪到 bindKeyboard 之后 ⇒ 时序断言变红。
import assert from 'node:assert/strict'
import { beforeEach, test, vi } from 'vitest'
import { computed, ref } from 'vue'

import { createStartFamily } from '../composables/ai/auto-loop/start-family.js'
// [plain-streak-v1] P2-4 守卫：initLoop 后 _plainStreak 应被清空
import { _plainStreak } from '../composables/ai/auto-loop/reply-handlers.js'

const winRef = vi.hoisted(() => ({ win: null as unknown }))
vi.mock('../composables/ai/useAiWindow', () => ({ getActiveWin: () => winRef.win }))

function makeInst() {
  return {
    state: ref('idle'),
    id: ref(''),
    sessionId: ref(''),
    goal: ref(''),
    round: ref(0),
    startCommit: ref(''),
    stopRequest: ref('none'),
    stopReason: ref(''),
    lastHash: ref(''),
    lastExec: ref(null),
  } as any
}

let events: string[] = []
let calls: Array<{ url: string, body: string }> = []

function makeFamily(sid: string) {
  const inst = makeInst()
  const family = createStartFamily({
    loopPaused: ref(false),
    activeLoop: computed(() => inst),
    isLoopActive: computed(() => false),
    persist: () => {},
    enterWaiting: () => {},
    runHook: async () => ({ event: 'LoopStop', action: 'ok', hooksRun: 0 }),
    finish: async () => {},
    bindKeyboard: () => { events.push('bindKeyboard') },
    stage: ref(''),
    getActiveSessionId: () => sid,
    transport: {} as any,
    setOriginalTitle: () => {},
  })
  return { family, inst }
}

beforeEach(() => {
  events = []
  calls = []
  winRef.win = { closed: false, focus() {} }
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: unknown }) => {
    const u = String(url)
    calls.push({ url: u, body: String(init?.body || '') })
    events.push(u.includes('/tasks') ? 'fetch:tasks' : 'fetch:other')
    return { ok: true, json: async () => ({ head: '' }) } as any
  }) as any
})

test('承重：initLoop 成功路径发出 mode:set 空 todo 的 POST，sid 取自 getActiveSessionId', async () => {
  const { family, inst } = makeFamily('s1')
  const ok = await family.initLoop(inst, 'loop', 'g')
  assert.equal(ok, true)
  const taskCall = calls.find(c => c.url.includes('/__ai/tasks'))
  assert.ok(taskCall, '未发出清桶 POST')
  const body = JSON.parse(taskCall!.body)
  assert.equal(body.mode, 'set')
  assert.equal(body.sid, 's1')
  assert.deepEqual(body.todo, [])
  assert.deepEqual(body.done, [])
})

test('承重：清桶必须在 bindKeyboard 之前发起（覆盖语义不得晚于启动）', async () => {
  const { family, inst } = makeFamily('s1')
  await family.initLoop(inst, 'loop', 'g')
  const iTasks = events.indexOf('fetch:tasks')
  const iBind = events.indexOf('bindKeyboard')
  assert.ok(iTasks >= 0, '未发出清桶')
  assert.ok(iBind >= 0, 'bindKeyboard 未调用')
  assert.ok(iTasks < iBind, '清桶应早于 bindKeyboard')
})

test('P2-4 承重：initLoop 后 _plainStreak 计数被清空', async () => {
  _plainStreak.set('stale-loop-id', 5)
  assert.equal(_plainStreak.size, 1, '前置：预置计数')
  const { family, inst } = makeFamily('s1')
  await family.initLoop(inst, 'loop', 'g')
  assert.equal(_plainStreak.size, 0, 'initLoop 后计数须清空（删 clear() 本测应变红）')
})

test('sid 空串 ⇒ 跳过清桶（与 finish 的 sid-guard 同语义）', async () => {
  const { family, inst } = makeFamily('')
  await family.initLoop(inst, 'loop', 'g')
  assert.equal(calls.some(c => c.url.includes('/__ai/tasks')), false, 'sid 空串不得清桶')
})
