// @vitest-environment happy-dom
// [rescan-no-autorun-v1] WO-20261006-03 段二：rescan 重扫只回填，不自动执行。
//   判据承重：删 rescan 过滤 ⇒ 本文件变红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'

import { PAGE_BOOT_TS, REFRESH_GUARD_MS, useAiReplyHandlers } from '../composables/ai/useAiReplyHandlers.js'

const h = vi.hoisted(() => ({
  runCalls: [] as unknown[],
  schedCalls: [] as unknown[],
  pushCalls: [] as unknown[],
}))

// [loop-consolidation-P3d] 删除 useAutoLoop mock：useAiReplyHandlers 已在 P2 摘除该依赖
vi.mock('../composables/ai/useAutoTakeover', () => ({
  useAutoTakeover: () => ({
    enabled: ref(false),
    disable: () => {},
    scheduleAutoRun: (fn: () => void) => { h.schedCalls.push(fn) },
  }),
}))
vi.mock('../composables/runner/useScriptInbox', () => ({
  useScriptInbox: () => ({
    push: (o: unknown) => { h.pushCalls.push(o); return { id: 'x', code: 'c', lang: 'js', site: '', hash: 'hh', desc: '', why: '', ts: 0 } },
  }),
}))
vi.mock('../composables/runner/useRunner', () => ({
  useRunner: () => ({ running: ref(false), run: (o: unknown) => { h.runCalls.push(o) } }),
  pushTerminalNotice: () => {},
}))
vi.mock('../composables/ui/useToast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('../composables/ai/useAiSite', () => ({ useAiSite: () => ({ url: ref(''), setUrl: () => {}, modelId: ref('m'), MODELS: [] }) }))
vi.mock('../composables/ai/useAiWaiting', () => ({ useAiWaiting: () => ({ stopWaiting: () => {} }) }))
// [stop-resume-v1] copyAndFill 为本会话新增的自动续推调用点所需；no-op 化避免 stopped 分支 TypeError
vi.mock('../composables/ai/useAiWindow', () => ({ useAiWindow: () => ({ listWindows: () => [], getWindowBySid: () => null, copyAndFill: () => Promise.resolve() }) }))
vi.mock('../composables/ai/useAiTransport', () => ({ transportKind: ref('tampermonkey') }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: ref('s1') }))
vi.mock('../composables/ui/useEventStream', () => ({ emit: () => {}, takePendingAskKey: () => '' }))
vi.mock('../composables/ui/useAsk', () => ({ askUser: async () => '' }))

beforeEach(() => { h.runCalls.length = 0; h.schedCalls.length = 0; h.pushCalls.length = 0 })

function mkHandlers() {
  return useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
}

function fakeEvent() { return { origin: 'https://x', source: null } as unknown as MessageEvent }

test('承重：rescan:true 的 script ⇒ 只回填 push，不执行 run/scheduleAutoRun', () => {
  const handlers = mkHandlers()
  const payload = { type: 'ai-runner:reply', kind: 'script', code: '// @desc a\n// @why b', lang: 'js', rescan: true, sessionId: 's1' }
  handlers.handleAiReply(payload, fakeEvent())
  expect(h.pushCalls.length).toBe(1)
  expect(h.runCalls.length).toBe(0)
  expect(h.schedCalls.length).toBe(0)
})

test('承重(源码锚点)：script 分支必须含 rescan 早退守卫，且在 scheduleAutoRun 之前', () => {
  const s = readFileSync('packages/client/composables/ai/useAiReplyHandlers.ts', 'utf8')
  // [loop-consolidation-P3d] 守卫形态已变为「块内先 reportArrival 再 return」；
  //   判据改锚定「rescan 判定 + 早退」的组合，保持与 scheduleAutoRun 的相对位置检查
  const guard = s.indexOf('if (payload.rescan === true) {')
  const sched = s.indexOf('autoTakeover.scheduleAutoRun')
  assert.ok(guard > 0, '缺少 rescan 早退守卫（[rescan-no-autorun-v1]）')
  assert.ok(sched > 0, '找不到 scheduleAutoRun')
  assert.ok(guard < sched, 'rescan 守卫必须在 scheduleAutoRun 之前')
})

test('反例：不带 rescan 的 script，在冷静期外 ⇒ 走原分流（scheduleAutoRun 被调用）', () => {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + REFRESH_GUARD_MS + 1)
  const handlers = mkHandlers()
  const payload = { type: 'ai-runner:reply', kind: 'script', code: '// @desc a\n// @why b', lang: 'js', sessionId: 's1' }
  handlers.handleAiReply(payload, fakeEvent())
  expect(h.pushCalls.length).toBe(1)
  expect(h.schedCalls.length).toBe(1)
  vi.useRealTimers()
})

test('冷静期内：不带 rescan 的 script 也不执行（只回填）', () => {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + 1)
  const handlers = mkHandlers()
  const payload = { type: 'ai-runner:reply', kind: 'script', code: '// @desc a\n// @why b', lang: 'js', sessionId: 's1' }
  handlers.handleAiReply(payload, fakeEvent())
  expect(h.pushCalls.length).toBe(1)
  expect(h.schedCalls.length).toBe(0)
  vi.useRealTimers()
})

// [a6-legacy-guard-v1] A6 承重判据（WO-20261006-04 段一）：旧油猴路径（ai-runner:script）的冷静期守卫。
//   载荷**不带 rescan** —— 旧油猴本来就没有该字段，这正是 A6 只能靠时间窗判断的原因。
test('A6①：冷静期内 ai-runner:script 不执行（只回填）', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + 1)
  const handlers = mkHandlers()
  const payload = { type: 'ai-runner:script', code: '// @desc a\n// @why b', lang: 'js', sessionId: 's1' }
  handlers.onSessionIdMessage({ data: payload, origin: 'https://x', source: null } as unknown as MessageEvent)
  await vi.advanceTimersByTimeAsync(8000)
  expect(h.pushCalls.length).toBe(1)
  expect(h.runCalls.length).toBe(0)
  vi.useRealTimers()
})

test('A6②：冷静期外 ai-runner:script 执行（runner.run 被调用）', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + REFRESH_GUARD_MS + 1)
  const handlers = mkHandlers()
  const payload = { type: 'ai-runner:script', code: '// @desc a\n// @why b', lang: 'js', sessionId: 's1' }
  handlers.onSessionIdMessage({ data: payload, origin: 'https://x', source: null } as unknown as MessageEvent)
  await vi.advanceTimersByTimeAsync(8000)
  expect(h.pushCalls.length).toBe(1)
  expect(h.runCalls.length).toBe(1)
  vi.useRealTimers()
})
