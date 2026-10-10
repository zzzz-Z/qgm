// [refresh-same-session-guard-v1] 承重判据：刷新（sessionStorage 恢复）必须复用上一会话的
//   规则去重记录与激活窗口槽位；且当 AI 窗口确已关闭时，必须清记录并重新注入规则。
// [VARIANT] 变异验证：注释掉 readRulesInjected 的 sessionStorage 读取 → 用例1 必红；
//   把 clearRulesForSid(rulesKey) 改回 clearRulesForSid(sid) → 用例3 必红。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const SS = new Map<string, string>()
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string) => (SS.has(k) ? SS.get(k)! : null),
    setItem: (k: string, v: string) => { SS.set(k, String(v)) },
    removeItem: (k: string) => { SS.delete(k) },
    clear: () => SS.clear(),
  },
})

const h = vi.hoisted(() => ({
  loadRulesBlock: vi.fn(async () => '<file path="SYSTEM.md">x</file>'),
  sendFillToAsync: vi.fn(async (_sid: string, _payload?: { prompt?: string, images?: string[] }) => 'sent'),
  currentSession: { value: 'sessA' },
  activeWin: { closed: false } as { closed: boolean },
  blankRef: false,
  openSeq: 0,
}))

vi.mock('@vueuse/core', () => ({
  useClipboard: () => ({ copy: async () => undefined }),
  promiseTimeout: () => Promise.resolve(),
}))
vi.mock('../composables/ai/load-rules.js', () => ({
  loadRulesBlock: h.loadRulesBlock,
  loadRulesParts: vi.fn(async () => ({ systemPart: '', agentsParts: [] })),
  clearRulesCache: vi.fn(),
}))
vi.mock('../composables/ai/useAiWindowSend', () => ({
  isHeadless: () => false,
  loadTransport: async () => ({}),
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
  getActiveWinImpl: () => h.activeWin,
  getActiveWinSidImpl: () => 'default',
  getWindowBySidImpl: () => null,
  isBlankRefImpl: () => h.blankRef,
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
  useSessionManager: () => ({ sessionId: h.currentSession, trackMessage: vi.fn() }),
}))
// [loop-consolidation-P3d] 删除 auto-loop/handoff 的 vi.mock：转发壳已在 P3a 摘除，mock 已无对应用户
vi.mock('../composables/ui/useToast', () => ({ toast: vi.fn() }))

function stubWindow(): void {
  h.openSeq = 0
  vi.stubGlobal('window', {
    open: vi.fn(() => {
      h.openSeq++
      // 第一次（B2 按名找回）：返回同源 about:blank（= 原窗口已关）
      if (h.openSeq === 1) return { closed: false, location: { href: 'about:blank' } }
      // 后续（B3 开新窗）：返回真窗口引用
      return { closed: false, location: null }
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
}

describe('刷新属同一会话（refresh-same-session-v1）', () => {
  beforeEach(() => {
    SS.clear()
    h.loadRulesBlock.mockClear()
    h.sendFillToAsync.mockClear()
    h.sendFillToAsync.mockResolvedValue('sent')
    h.activeWin = { closed: false }
    h.blankRef = false
    vi.unstubAllGlobals()
  })

  it('sessionStorage 已有去重记录 → 刷新后首问不重复注入', async () => {
    SS.set('__ai_rules_injected', JSON.stringify(['default:sessA']))
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessA'
    await mod.copyAndFill('q1')
    expect(h.loadRulesBlock).not.toHaveBeenCalled()
  })

  it('sessionStorage 为空 → 首问必须注入（防恢复逻辑吃空集）', async () => {
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessB'
    await mod.copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
  })

  it('刷新恢复记录 + 窗口已关 + 发送失败 → 记录必须被真清除（承重：防传裸 sid）', async () => {
    SS.set('__ai_rules_injected', JSON.stringify(['default:sessA']))
    h.activeWin = { closed: true }
    h.blankRef = true
    // 发送失败：不触发 rules-mark-on-success 重新登记，清除效果不会被掩盖
    h.sendFillToAsync.mockResolvedValue('failed')
    stubWindow()
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessA'
    await mod.copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
    const payload = h.sendFillToAsync.mock.calls[0]?.[1] as { prompt?: string } | undefined
    expect(String(payload && payload.prompt)).toContain('SYSTEM.md')
    // 核心断言：传裸 sid 时清除失效，残留会让下次调用漏带规则
    const left = JSON.parse(SS.get('__ai_rules_injected') || '[]') as string[]
    expect(left).not.toContain('default:sessA')
  })

  it('用户手动关窗后再发消息 → 走 B2 恢复分支，记录被清且重新注入', async () => {
    // 与「刷新后」同源：windowTable 引用失效 → B1 skipped → B2 open('', name) 拿回空白页
    SS.set('__ai_rules_injected', JSON.stringify(['default:sessA']))
    h.activeWin = { closed: true }
    h.blankRef = true
    h.sendFillToAsync.mockResolvedValue('failed')
    stubWindow()
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessA'
    await mod.copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
    const left = JSON.parse(SS.get('__ai_rules_injected') || '[]') as string[]
    expect(left).not.toContain('default:sessA')
  })

  it('activeWinSid 从 sessionStorage 恢复（刷新后槽位不错位）', async () => {
    SS.set('__ai_active_win_sid', 'win_deepseek')
    vi.resetModules()
    const real = await vi.importActual<typeof import('../composables/ai/useAiWindowTable')>('../composables/ai/useAiWindowTable')
    expect(real.getActiveWinSidImpl()).toBe('win_deepseek')
  })

  it('activeWinSid 无记录时回退 default（防恢复逻辑恒返空）', async () => {
    vi.resetModules()
    const real = await vi.importActual<typeof import('../composables/ai/useAiWindowTable')>('../composables/ai/useAiWindowTable')
    expect(real.getActiveWinSidImpl()).toBe('default')
  })
})
