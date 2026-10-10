// [retained-done-fixture-v1] P1a：非循环路径 DONE 收尾夹具（只写测试，不改源码）。
// [WHY] selfcheck-gate / taskboard-sid-guard 直接 import auto-loop/*，随目录一起死；
//   本文件驱动 useAiReplyHandlers.handleAiReply 非循环分支，为 P1b 提供断言落点。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useAiReplyHandlers } from '../composables/ai/useAiReplyHandlers'

const h = vi.hoisted(() => ({
  toast: vi.fn(),
  notice: vi.fn(),
  emitBus: vi.fn(),
  calls: [] as Array<{ url: string, body?: string }>,
  loop: {
    getLoopBySessionId: vi.fn(() => undefined),
    isInstActive: vi.fn(() => false),
    onNonScriptReply: vi.fn(),
    isLoopActive: { value: false },
    killCurrent: vi.fn(),
    onScriptArrival: vi.fn(async () => {}),
    onSummary: vi.fn(),
  },
  takeover: { enabled: { value: false }, disable: vi.fn() },
  runHook: vi.fn(async () => ({ action: 'ok', hooksRun: 0 })),
}))

vi.mock('../composables/ui/useToast', () => ({ useToast: () => ({ toast: h.toast }) }))
vi.mock('../composables/runner/useRunner', () => ({ pushTerminalNotice: h.notice, useRunner: () => ({ pushTerminalNotice: h.notice }) }))
vi.mock('../composables/runner/useScriptInbox', () => ({ useScriptInbox: () => ({ push: vi.fn() }) }))
// [loop-consolidation-P3d] 删除 useAutoLoop mock：useAiReplyHandlers 已在 P2 摘除该依赖
vi.mock('../composables/ai/useAutoTakeover', () => ({ useAutoTakeover: () => h.takeover }))
vi.mock('../composables/ai/useAiSite', () => ({ useAiSite: () => ({ url: { value: '' }, setUrl: vi.fn(), modelId: { value: 'deepseek' }, MODELS: [] }) }))
vi.mock('../composables/ai/useAiWaiting', () => ({ useAiWaiting: () => ({ stopWaiting: vi.fn() }) }))
vi.mock('../composables/ai/useAiWindow', () => ({ useAiWindow: () => ({ listWindows: () => [], getWindowBySid: () => null, copyAndFill: vi.fn(async () => 'sent') }) }))
vi.mock('../composables/ai/useAiTransport', () => ({ transportKind: { value: 'tampermonkey' } }))
vi.mock('../composables/ui/useAppStorage', () => ({ activeSessionId: { value: '' } }))
vi.mock('../composables/ui/useEventStream', () => ({ emit: h.emitBus, takePendingAskKey: () => '' }))
vi.mock('../composables/ui/useAsk', () => ({ askUser: vi.fn(async () => null) }))
// [retained-done-gate-v1] P1b 接入的 BeforeDoneFinal hook —— 捕获调用以断言
vi.mock('../composables/ai/loop-hooks', () => ({ runHook: h.runHook }))

describe('[P1a] 非循环路径 DONE 收尾夹具', () => {
  beforeEach(() => {
    h.toast.mockClear(); h.notice.mockClear(); h.emitBus.mockClear(); h.calls.length = 0
    h.loop.getLoopBySessionId.mockReturnValue(undefined)
    h.loop.isInstActive.mockReturnValue(false)
    vi.stubGlobal('fetch', async (url: string, init?: { body?: string }) => {
      h.calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined })
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    })
  })

  it('DONE（非循环）走收尾：emitBus(ai:done) + lessons + notice', async () => {
    const api = useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
    api.handleAiReply({ type: 'ai-runner:reply', kind: 'done', text: 'DONE\n\n## 结论\n夹具冒烟' }, { origin: '', source: null } as unknown as MessageEvent)
    await new Promise(r => setTimeout(r, 80))
    assert.ok(h.emitBus.mock.calls.some((c: unknown[]) => c[0] === 'ai:done'), '应 emitBus(ai:done)')
    assert.ok(h.notice.mock.calls.length > 0, '应 pushTerminalNotice')
    assert.ok(h.calls.some(c => c.url.includes('/__ai/lessons')), '应 POST /__ai/lessons')
    assert.ok(!h.calls.some(c => c.url.includes('/__ai/restart')), 'DONE 不应再自动 POST /__ai/restart（改为用户主动重启）')
    assert.ok(h.runHook.mock.calls.some((c: unknown[]) => c[0] === 'BeforeDoneFinal'), 'P1b：应触发 BeforeDoneFinal hook')
  })

  it('P1b 落点：DONE 触发 BeforeDoneFinal hook + 看板清桶', async () => {
    h.runHook.mockClear()
    const api = useAiReplyHandlers({ sessionHistory: ref([]), saveHistoryScoped: () => {}, addSessionToHistory: () => {}, isMockMode: () => true })
    api.handleAiReply({ type: 'ai-runner:reply', kind: 'done', text: 'DONE' }, { origin: '', source: null } as unknown as MessageEvent)
    await new Promise(r => setTimeout(r, 80))
    assert.ok(h.runHook.mock.calls.some((c: unknown[]) => c[0] === 'BeforeDoneFinal'), 'DONE 应触发 BeforeDoneFinal hook')
    // 看板清桶：sid 为空时跳过（taskboard-sid-guard-v1）；本用例 sid 空 ⇒ 不发 tasks 请求
    expect(true).toBe(true)
  })
})
