// @vitest-environment happy-dom
// [stopped-no-autorun-v1] WO-20261005 段三判定为缺陷的「循环外自动执行」旁路：
//   循环已随 stopped 被 finish（存档 / 清看板 / LoopStop），此时同一条被中止的回复里若还留着
//   完整代码块，脚本仍会被推出并被 `autoTakeover.scheduleAutoRun`（无条件立即 fn()）执行 ⇒
//   不在任何轮次记账、不进本轮 commit、无自检闸门、无预算反馈。
//   判据承重：摘掉任一处守卫 ⇒ 对应用例变红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { expect, test, vi } from 'vitest'
import { ref } from 'vue'

import { PAGE_BOOT_TS, REFRESH_GUARD_MS, STOPPED_GUARD_MS, useAiReplyHandlers } from '../composables/ai/useAiReplyHandlers.js'
// [stopped-vocab-guard-v1] 停机态整句一律不落源码：用抬头常量，避免把整句再写回来
//   （整句与本仓探针正则同形 ⇒ 源码被 dump 进会话时被自身探针命中，见 utils/stop-notice.ts 文件头）
import { STOPPED_HEAD } from '../utils/stop-notice.js'

const h = vi.hoisted(() => ({
  runCalls: [] as unknown[],
  schedCalls: [] as unknown[],
  pushCalls: [] as unknown[],
}))

// [loop-consolidation-P3d] 删除 useAutoLoop mock：useAiReplyHandlers 已在 P2 摘除该依赖
vi.mock('../composables/ai/useAutoTakeover', () => ({
  // 致命点：scheduleAutoRun 就是无条件立即 fn()，连 enabled 都不看
  useAutoTakeover: () => ({ enabled: ref(false), disable: () => {}, scheduleAutoRun: (fn: () => void) => fn() }),
}))
vi.mock('../composables/runner/useScriptInbox', () => ({
  useScriptInbox: () => ({ push: (o: unknown) => { h.pushCalls.push(o); return { id: 'x', code: 'c', lang: 'js', site: '', hash: 'hh', desc: '', why: '', ts: 0 } } }),
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

/**
 * [WHY] 必须落在执行分流生效的时段：落在 [refresh-no-autorun-v1] 的 3s 冷静期内时，
 *   脚本会先被冷静期挡下 ⇒ 用例恒绿（判据不承重，拦人的不是 stopped 守卫）。
 */
function enterRuntimeWindow(): void {
  vi.useFakeTimers()
  vi.setSystemTime(PAGE_BOOT_TS + REFRESH_GUARD_MS + 1)
}

function mkHandlers() {
  return useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
}
function fakeEvent() { return { origin: 'https://x', source: null } as unknown as MessageEvent }

function SCRIPT(sid: string) {
  return {
    type: 'ai-runner:reply',
    kind: 'script',
    code: '// @desc d\n// @why w\nconsole.log(1)',
    lang: 'js',
    hash: `h-${sid}-${Math.random()}`,
    sessionId: sid,
  }
}

test('① stopped 后窗口内的残余脚本 ⇒ 只回填，不自动执行（run/scheduleAutoRun 均无）', () => {
  enterRuntimeWindow()
  h.runCalls.length = 0; h.schedCalls.length = 0; h.pushCalls.length = 0
  const handlers = mkHandlers()
  handlers.handleAiReply({ type: 'ai-runner:reply', kind: 'stopped', text: STOPPED_HEAD, sessionId: 'sid-s1' }, fakeEvent())
  handlers.handleAiReply(SCRIPT('sid-s1'), fakeEvent())
  expect(h.pushCalls.length).toBe(1) // 仍回填编辑器
  expect(h.runCalls.length).toBe(0)
  vi.useRealTimers()
})

test('② 旧油猴 ai-runner:script（3-7s 异步延迟）在 stopped 之后 ⇒ 也不执行', async () => {
  enterRuntimeWindow()
  h.runCalls.length = 0
  const handlers = mkHandlers()
  // 先发脚本（进入延迟），等待期间 AI 页面被停止 ⇒ await 后的窗口判据必须拦住
  const p = handlers.onSessionIdMessage({ data: { type: 'ai-runner:script', code: '// @desc d\n// @why w', lang: 'js', sessionId: 'sid-s2' }, origin: 'https://x', source: null } as unknown as MessageEvent)
  await vi.advanceTimersByTimeAsync(1500)
  handlers.handleAiReply({ type: 'ai-runner:reply', kind: 'stopped', text: STOPPED_HEAD, sessionId: 'sid-s2' }, fakeEvent())
  await vi.advanceTimersByTimeAsync(8000)
  await p
  expect(h.runCalls.length).toBe(0)
  vi.useRealTimers()
})

test('③ 反例：无 stopped 前置的脚本 ⇒ 照常自动执行（守卫不误伤正常链路）', () => {
  enterRuntimeWindow()
  h.runCalls.length = 0
  const handlers = mkHandlers()
  handlers.handleAiReply(SCRIPT('sid-s3'), fakeEvent())
  expect(h.runCalls.length).toBe(1)
  vi.useRealTimers()
})

test('④ 反例：窗口外的脚本 ⇒ 照常自动执行（新一轮真实回复不受影响）', () => {
  enterRuntimeWindow()
  const t0 = PAGE_BOOT_TS + REFRESH_GUARD_MS + 1
  h.runCalls.length = 0
  const handlers = mkHandlers()
  handlers.handleAiReply({ type: 'ai-runner:reply', kind: 'stopped', text: 'x', sessionId: 'sid-s4' }, fakeEvent())
  vi.setSystemTime(t0 + STOPPED_GUARD_MS + 1)
  handlers.handleAiReply(SCRIPT('sid-s4'), fakeEvent())
  expect(h.runCalls.length).toBe(1)
  vi.useRealTimers()
})

test('⑤ [parity] 三处守卫同源且均 anchored 到同一 tag', () => {
  const um = readFileSync('scripts/tampermonkey-session-id.user.js', 'utf8')
  assert.ok(um.includes('[stopped-no-autorun-v1]'), '油猴缺 script 分支守卫')
  assert.ok(/const s = \(markedNonScript \|\| stopPosted\)/.test(um), '油猴 script 分支未串入 stopPosted')

  const hj = readFileSync('packages/core/src/headless/headless-inject.ts', 'utf8')
  assert.ok(hj.includes('[stopped-no-autorun-v1]'), 'headless 缺 script 分支守卫')
  assert.ok(/const script = markedNonScript \|\| stoppedThisRound/.test(hj), 'headless script 分支未串入 stoppedThisRound')

  const fe = readFileSync('packages/client/composables/ai/useAiReplyHandlers.ts', 'utf8')
  assert.ok((fe.match(/if \(inStoppedWindow\(sid\)\)/g) || []).length >= 3, '前端三处买入点均须判 stopped 窗口')
  // legacy 通道的判据必须在 await 之后（否则 3-7s 延迟期间到达的 stopped 拦不住）
  const awaitLine = fe.indexOf('await promiseTimeout(delayMs)')
  const legacyGuard = fe.indexOf('if (inStoppedWindow(sid)) {', awaitLine)
  assert.ok(awaitLine > 0 && legacyGuard > awaitLine, 'legacy 通道的 stopped 判据必须在 await promiseTimeout 之后')
})
