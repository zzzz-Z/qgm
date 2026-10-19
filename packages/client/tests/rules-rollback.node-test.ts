// [rules-mark-on-success-guard-v1] 承重判据：规则去重只应在投递成功时登记。
// [WHY] 无此测试则「首问未带规则」修复可被静默回退（登记照旧消耗额度）而全仓测试全绿。
// [VARIANT] 变异验证：把 markRulesInjected 调用移到发送前，用例1 必红。
// [CONSTRAINT] 模块级 _rulesInjectedSids 跨用例累积，故每个用例用唯一 sessionId 隔离。
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { copyAndFill } from '../composables/ai/useAiWindow'

const h = vi.hoisted(() => ({
  loadRulesBlock: vi.fn(async () => ''),
  sendFillToAsync: vi.fn(async () => 'failed'),
  trackMessage: vi.fn(),
  toast: vi.fn(),
  currentSession: { value: 'sessA' },
}))

vi.mock('@vueuse/core', () => ({
  useClipboard: () => ({ copy: async () => undefined }),
  promiseTimeout: (ms: number) => new Promise(r => setTimeout(r, ms)),
}))
vi.mock('../composables/ai/load-rules.js', () => ({
  loadRulesBlock: h.loadRulesBlock,
  loadRulesParts: vi.fn(async () => ({ systemPart: '', agentsParts: [] })),
  clearRulesCache: vi.fn(),
}))
vi.mock('../composables/ai/useAiWindowSend', () => ({
  isHeadless: () => false,
  loadTransport: async () => ({}),
  nextFillMsgId: () => 'test-fill-msg',
  sendFill: vi.fn(() => true),
  sendFillTo: vi.fn(() => true),
  sendFillToAsync: h.sendFillToAsync,
  sendNewSession: vi.fn(),
  sendNewSessionTo: vi.fn(),
  sendRotate: vi.fn(),
  sendRotateTo: vi.fn(),
  sendStop: vi.fn(),
  sendStopTo: vi.fn(),
}))
vi.mock('../composables/ai/useAiWindowTable', () => ({
  getActiveWinImpl: () => ({ closed: false }),
  getActiveWinSidImpl: () => 'default',
  getWindowBySidImpl: () => null,
  isBlankRefImpl: () => false,
  listWindowsImpl: () => [],
  markWindowOpened: vi.fn(),
  removeWindowBySidImpl: vi.fn(),
  setActiveWinImpl: vi.fn(),
  setActiveWinSidImpl: vi.fn(),
  setWindowEntry: vi.fn(),
  targetOriginImpl: () => '',
  targetOriginFor: () => '',
}))
vi.mock('../composables/ai/useAiSite', () => ({
  url: { value: '' },
  currentSiteUrl: () => '',
  useAiSite: () => ({ url: { value: '' }, setUrl: vi.fn() }),
}))
vi.mock('../composables/ai/useSessionManager', () => ({
  useSessionManager: () => ({ sessionId: h.currentSession, trackMessage: h.trackMessage }),
}))
// [loop-consolidation-P3d] 删除 auto-loop/handoff 的 vi.mock：转发壳已在 P3a 摘除，mock 已无对应用户
vi.mock('../composables/ui/useToast', () => ({ toast: h.toast }))

describe('规则注入去重登记时机（rules-mark-on-success-v1）', () => {
  beforeEach(() => {
    h.loadRulesBlock.mockClear()
    h.sendFillToAsync.mockClear()
  })

  it('投递 failed → 不登记，下次调用必须重新注入', async () => {
    h.currentSession.value = 'sessA'
    h.sendFillToAsync.mockResolvedValue('failed')
    await copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
    await copyAndFill('q2')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(2)
  })

  it('投递 sent → 登记，下次调用不得重复注入（既有行为防退化）', async () => {
    h.currentSession.value = 'sessB'
    h.sendFillToAsync.mockResolvedValue('sent')
    await copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
    await copyAndFill('q2')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
  })
})
