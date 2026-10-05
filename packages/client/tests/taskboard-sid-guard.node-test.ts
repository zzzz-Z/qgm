// @vitest-environment happy-dom
// [taskboard-sid-guard-v1] D2：sid 空必须禁用轮询与渲染（禁止回落全局桶）
import { beforeEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

import TaskProgressPanel from '../components/script/TaskProgressPanel.vue'

const { sidRef } = vi.hoisted(() => ({ sidRef: { value: '' } }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: sidRef, effectiveSessionId: sidRef }))

const origFetch = globalThis.fetch

beforeEach(() => {
  sidRef.value = ''
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ todo: [], done: [] }) }) as any
})

test('D2: sid 空 → 不发起 fetch', async () => {
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(globalThis.fetch).not.toHaveBeenCalled()
  w.unmount()
  globalThis.fetch = origFetch
})

test('D2: sid 非空 → 发起 fetch 且带 sid 参数', async () => {
  sidRef.value = 's1'
  const w = mount(TaskProgressPanel)
  await flushPromises()
  const mock = globalThis.fetch as any
  expect(mock).toHaveBeenCalled()
  expect(String(mock.mock.calls[0][0])).toContain('sid=s1')
  w.unmount()
  globalThis.fetch = origFetch
})

test('D2: sid 空 → 面板不渲染', async () => {
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').exists()).toBe(false)
  w.unmount()
  globalThis.fetch = origFetch
})

test('D2: sid 非空且有数据 → 面板渲染', async () => {
  sidRef.value = 's1'
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ todo: ['T1'], done: [] }) }) as any
  const w = mount(TaskProgressPanel)
  await flushPromises()
  expect(w.find('.task-progress').exists()).toBe(true)
  w.unmount()
  globalThis.fetch = origFetch
})

function makeInst(sid: string) {
  return {
    state: ref('waiting'),
    id: ref('L1'),
    sessionId: ref(sid),
    round: ref(1),
    goal: ref('g'),
    startCommit: ref(''),
    stopRequest: ref('none' as const),
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

async function runFinish(sid: string) {
  const { createStopAndFinish } = await import('../composables/ai/auto-loop/stop-and-finish.js')
  const calls: Array<{ url: string, body: string }> = []
  globalThis.fetch = vi.fn(async (url: any, init: any) => {
    calls.push({ url: String(url), body: String(init?.body || '') })
    return { ok: true, json: async () => ({ ok: true }) }
  }) as any
  const f = createStopAndFinish({
    loopPaused: ref(false),
    persist: () => {},
    transport: { sendStop: () => {} } as any,
    toast: () => {},
    runHook: async () => ({ event: 'LoopStop', action: 'ok', hooksRun: 0 }),
    unbindKeyboard: () => {},
    handoffDisarm: () => {},
  } as any)
  await f.finish(makeInst(sid), 'done', 'test')
  return calls.filter(c => c.url.includes('/__ai/tasks'))
}

test('D2.2: sid 空 → finish 不发清空请求', async () => {
  const taskCalls = await runFinish('')
  expect(taskCalls.length).toBe(0)
  globalThis.fetch = origFetch
})

test('D2.2: sid 非空 → finish 发清空请求（带 sid）', async () => {
  const taskCalls = await runFinish('s1')
  expect(taskCalls.length).toBe(1)
  expect(taskCalls[0].body).toContain('"sid":"s1"')
  globalThis.fetch = origFetch
})
