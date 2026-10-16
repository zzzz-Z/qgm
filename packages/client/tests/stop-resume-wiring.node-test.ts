// @vitest-environment happy-dom
// [stop-resume-wiring-v1] 「自动续推」端到端接线验证——构造 stopped 消息，断言工作台真的发了「继续」。
//
// [WHY] 上一批只测了 stop-resume.ts 的**纯决策逻辑**（decideOnStopped 返回什么）。
//   本文件测的是**接线**：stopped 消息真的到达前端后，1.5s 后是否真的调用 copyAndFill("继续")。
//   「逻辑对」不等于「接线对」——漏掉 setTimeout 或参数写错都不会被纯逻辑测试发现。
//
// [判据承重] 删掉 stopped 分支里的续推调用 / 改错文案 / 去掉上限判断 ⇒ 对应用例必红。
import { beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'

import { PAGE_BOOT_TS, REFRESH_GUARD_MS, useAiReplyHandlers } from '../composables/ai/useAiReplyHandlers.js'
import { _resetAll, markUserStop, MAX_AUTO_RESUME } from '../composables/ai/stop-resume.js'
// [stopped-vocab-guard-v1] 停机态整句不连写：用 utils/stop-notice 的分段常量
import { STOPPED_HEAD } from '../utils/stop-notice.js'

// ── 捕获 copyAndFill 调用（这是「真的发了继续」的唯一证据）
const h = vi.hoisted(() => ({
  fillCalls: [] as Array<{ prompt: string, opts?: unknown }>,
  toasts: [] as string[],
}))

vi.mock('../composables/ai/useAutoTakeover', () => ({
  useAutoTakeover: () => ({ enabled: ref(false), disable: () => {}, scheduleAutoRun: (fn: () => void) => fn() }),
}))
vi.mock('../composables/runner/useScriptInbox', () => ({
  useScriptInbox: () => ({ push: () => ({ id: 'x', code: '', lang: 'js', site: '', hash: 'h', desc: '', why: '', ts: 0 }) }),
}))
vi.mock('../composables/runner/useRunner', () => ({
  useRunner: () => ({ running: ref(false), run: () => {} }),
  pushTerminalNotice: () => {},
}))
vi.mock('../composables/ui/useToast', () => ({
  useToast: () => ({ toast: (msg: string) => { h.toasts.push(String(msg)) } }),
}))
vi.mock('../composables/ai/useAiSite', () => ({ useAiSite: () => ({ url: ref(''), setUrl: () => {}, modelId: ref('m'), MODELS: [] }) }))
vi.mock('../composables/ai/useAiWaiting', () => ({ useAiWaiting: () => ({ stopWaiting: () => {} }) }))
vi.mock('../composables/ai/useAiWindow', () => ({
  useAiWindow: () => ({
    listWindows: () => [],
    getWindowBySid: () => null,
    // 捕获调用参数：prompt 必须是「继续」，opts 必须 skipRules=true
    copyAndFill: (prompt: string, opts?: unknown) => {
      h.fillCalls.push({ prompt: String(prompt), opts })
      return Promise.resolve()
    },
  }),
}))
vi.mock('../composables/ai/useAiTransport', () => ({ transportKind: ref('tampermonkey') }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: ref('s1') }))
vi.mock('../composables/ui/useEventStream', () => ({ emit: () => {}, takePendingAskKey: () => '' }))
vi.mock('../composables/ui/useAsk', () => ({ askUser: async () => '' }))

const SID = 'sid-resume'

function mkHandlers() {
  return useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
}
function fakeEvent() { return { origin: 'https://x', source: null } as unknown as MessageEvent }
function stoppedMsg(sid: string) {
  return { type: 'ai-runner:reply', kind: 'stopped', text: STOPPED_HEAD, sessionId: sid }
}

beforeEach(() => {
  _resetAll()
  h.fillCalls.length = 0
  h.toasts.length = 0
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + REFRESH_GUARD_MS + 1)
})

test('① 平台自动停（无标记）⇒ 1.5s 后真的发出「继续」', async () => {
  const handlers = mkHandlers()
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  expect(h.fillCalls.length, 'stopped 到达瞬间不该立即发（有 1.5s 延迟）').toBe(0)
  await vi.advanceTimersByTimeAsync(1500)
  expect(h.fillCalls.length).toBe(1)
  expect(h.fillCalls[0].prompt).toBe('继续')
  expect(h.fillCalls[0].opts).toEqual({ skipRules: true })
  vi.useRealTimers()
})

test('② 连续两次平台自动停 ⇒ 发两次「继续」', async () => {
  const handlers = mkHandlers()
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  await vi.advanceTimersByTimeAsync(1500)
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  await vi.advanceTimersByTimeAsync(1500)
  expect(h.fillCalls.length).toBe(2)
  expect(h.fillCalls.every(c => c.prompt === '继续')).toBe(true)
  vi.useRealTimers()
})

test('③ 达上限（MAX_AUTO_RESUME 次后）⇒ 不再发，且弹提示', async () => {
  const handlers = mkHandlers()
  for (let i = 0; i < MAX_AUTO_RESUME; i++) {
    handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
    await vi.advanceTimersByTimeAsync(1500)
  }
  expect(h.fillCalls.length).toBe(MAX_AUTO_RESUME)
  // 第 MAX+1 次：不发，但弹 toast
  h.toasts.length = 0
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  await vi.advanceTimersByTimeAsync(1500)
  expect(h.fillCalls.length, '达上限后不该再发「继续」').toBe(MAX_AUTO_RESUME)
  expect(h.toasts.some(t => /已自动续推/.test(t))).toBe(true)
  vi.useRealTimers()
})

test('④ 用户主动停（有标记）⇒ 不发「继续」（尊重意图）', async () => {
  markUserStop(SID)
  const handlers = mkHandlers()
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  await vi.advanceTimersByTimeAsync(1500)
  expect(h.fillCalls.length, '用户主动停不该触发自动续推').toBe(0)
  vi.useRealTimers()
})

test('⑤ 用户主动停后，配额不被消耗（下次平台自动停仍可续推）', async () => {
  markUserStop(SID)
  const handlers = mkHandlers()
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  await vi.advanceTimersByTimeAsync(1500)
  // 标记已消费 ⇒ 下一次是平台自动停
  handlers.handleAiReply(stoppedMsg(SID), fakeEvent())
  await vi.advanceTimersByTimeAsync(1500)
  expect(h.fillCalls.length, '用户主动停不占配额，后续自动停仍可续推').toBe(1)
  vi.useRealTimers()
})
