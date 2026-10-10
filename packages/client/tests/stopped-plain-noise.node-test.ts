// @vitest-environment happy-dom
// [stopped-plain-noise-v1] 「已停止」半截回复的 plain 补发必须被三层守卫拦下：
//   ① 油猴 classifyAndPost（stopPosted 标志）② headless detectReplyInPage（_stoppedReported）
//   ③ 前端通道入口（stopped 后窗口内的 plain 丢弃，不依赖油猴更新即时生效）。
//   判据承重：摘掉任一守卫 ⇒ 对应用例变红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beforeEach, expect, test, vi } from 'vitest'
import { ref } from 'vue'

import { STOPPED_PLAIN_GUARD_MS, useAiReplyHandlers } from '../composables/ai/useAiReplyHandlers.js'

const h = vi.hoisted(() => ({
  emitCalls: [] as unknown[][],
}))

// [loop-consolidation-P3d] 删除 useAutoLoop mock：useAiReplyHandlers 已在 P2 摘除该依赖
vi.mock('../composables/ai/useAutoTakeover', () => ({
  useAutoTakeover: () => ({ enabled: ref(false), disable: () => {}, scheduleAutoRun: () => {} }),
}))
vi.mock('../composables/runner/useScriptInbox', () => ({
  useScriptInbox: () => ({ push: () => null }),
}))
vi.mock('../composables/runner/useRunner', () => ({
  useRunner: () => ({ running: ref(false), run: () => {} }),
  pushTerminalNotice: () => {},
}))
vi.mock('../composables/ui/useToast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('../composables/ai/useAiSite', () => ({ useAiSite: () => ({ url: ref(''), setUrl: () => {}, modelId: ref('m'), MODELS: [] }) }))
vi.mock('../composables/ai/useAiWaiting', () => ({ useAiWaiting: () => ({ stopWaiting: () => {} }) }))
vi.mock('../composables/ai/useAiWindow', () => ({ useAiWindow: () => ({ listWindows: () => [], getWindowBySid: () => null }) }))
vi.mock('../composables/ai/useAiTransport', () => ({ transportKind: ref('tampermonkey') }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: ref('s1') }))
vi.mock('../composables/ui/useEventStream', () => ({
  emit: (...a: unknown[]) => { h.emitCalls.push(a) },
  takePendingAskKey: () => '',
}))
vi.mock('../composables/ui/useAsk', () => ({ askUser: async () => '' }))

beforeEach(() => { h.emitCalls.length = 0 })

function mkHandlers() {
  return useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
}

function fakeEvent() { return { origin: 'https://x', source: null } as unknown as MessageEvent }

const STOPPED = { type: 'ai-runner:reply', kind: 'stopped', text: 'AI 网页已停止生成', sessionId: '' }
// 模拟「已停止」半截回复的补发 plain：长文本、无任何标记行（marks.script=0，上代守卫拦不住）
function PARTIAL_PLAIN(sid: string) {
  return {
    type: 'ai-runner:reply',
    kind: 'plain',
    text: `从输出看出, 18处已改, 2处跳过:\n\n- 初级产品管理\n- 元数据管理\n- 分类摘要初级产品\n\n原 ${sid}.ts 内容残缺`,
    sessionId: sid,
  }
}

test('① stopped 后窗口内的 plain ⇒ 不渲染（emit 无 ai:plain）', () => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.now())
  const handlers = mkHandlers()
  handlers.handleAiReply({ ...STOPPED, sessionId: 'sid-a' }, fakeEvent())
  handlers.handleAiReply(PARTIAL_PLAIN('sid-a'), fakeEvent())
  expect(h.emitCalls.some(c => c[0] === 'ai:plain')).toBe(false)
  vi.useRealTimers()
})

test('② stopped 后窗口外的 plain ⇒ 照常渲染（守卫随窗口过期，不误伤新一轮回复）', () => {
  vi.useFakeTimers()
  const t0 = Date.now()
  vi.setSystemTime(t0)
  const handlers = mkHandlers()
  handlers.handleAiReply({ ...STOPPED, sessionId: 'sid-b' }, fakeEvent())
  vi.setSystemTime(t0 + STOPPED_PLAIN_GUARD_MS + 1)
  handlers.handleAiReply(PARTIAL_PLAIN('sid-b'), fakeEvent())
  expect(h.emitCalls.some(c => c[0] === 'ai:plain')).toBe(true)
  vi.useRealTimers()
})

test('③ 无 stopped 前置的 plain ⇒ 照常渲染（守卫不改变正常链路）', () => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.now())
  const handlers = mkHandlers()
  handlers.handleAiReply(PARTIAL_PLAIN('sid-c'), fakeEvent())
  expect(h.emitCalls.some(c => c[0] === 'ai:plain')).toBe(true)
  vi.useRealTimers()
})

test('④ [parity] 三层守卫同源：油猴 stopPosted / headless _stoppedReported / 前端窗口守卫均在位', () => {
  const um = readFileSync('scripts/tampermonkey-session-id.user.js', 'utf8')
  assert.ok(um.includes('[stopped-plain-noise-v1]'), '油猴缺 [stopped-plain-noise-v1] 守卫')
  assert.ok(um.includes('if (stopPosted) return'), '油猴 plain 分支缺 stopPosted 早退')
  assert.ok(um.match(/^\s*stopPosted = false/gm)?.length === 2, '油猴 fill/rotate 两处必须重置 stopPosted')

  const hj = readFileSync('packages/core/src/headless/headless-inject.ts', 'utf8')
  assert.ok(hj.includes('[stopped-plain-noise-v1]'), 'headless 缺 [stopped-plain-noise-v1] 守卫')
  assert.ok(hj.includes('if (dedup._stoppedReported) return null'), 'headless plain 分支缺 _stoppedReported 早退')

  const fe = readFileSync('packages/client/composables/ai/useAiReplyHandlers.ts', 'utf8')
  assert.ok(fe.includes('[stopped-plain-noise-v1]'), '前端通道入口缺 [stopped-plain-noise-v1] 守卫')
  assert.ok(fe.includes('stoppedAtBySid.set(sid, Date.now())'), 'stopped 分支必须记录时刻')
})
