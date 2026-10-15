// [rules-concurrent-lock-v1] 承重判据：同一 sid 的两次并发 copyAndFill 只允许注入一次规则头。
// [VARIANT] 变异验证：删掉 copyAndFill 判定里的 !_rulesPendingSids.has(sid) → 用例1 必红
//   （第一次 prepend 挂起期间第二次也能通过判据 → loadRulesBlock 被调两次）。
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
  sendFillToAsync: vi.fn(async (_sid: string, _payload?: { prompt?: string }) => 'sent' as string),
  currentSession: { value: 'sessA' },
  activeWin: { closed: false } as { closed: boolean },
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
  useSessionManager: () => ({ sessionId: h.currentSession, trackMessage: vi.fn() }),
}))
vi.mock('../composables/data/useWorkspaces', () => ({
  useWorkspaces: () => ({
    activeId: { value: '' },
    load: vi.fn(async () => undefined),
    getFirstPromptSent: vi.fn(async () => false),
    setFirstPromptSent: vi.fn(async () => true),
  }),
}))
vi.mock('../composables/ui/useToast', () => ({ toast: vi.fn() }))

async function flush(times = 60): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function stubWindow(): void {
  vi.stubGlobal('window', {
    open: vi.fn(() => ({ closed: false, location: null })),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })
}

describe('rules 并发锁（rules-pending-lock-v1）', () => {
  beforeEach(() => {
    SS.clear()
    h.loadRulesBlock.mockClear()
    h.sendFillToAsync.mockClear()
    h.sendFillToAsync.mockResolvedValue('sent')
    h.activeWin = { closed: false }
    stubWindow()
  })

  it('prepend 挂起期间的第二次调用不得再注入（承重：判定须排除 pending）', async () => {
    let releaseFirst: ((v: string) => void) | null = null
    h.loadRulesBlock.mockImplementationOnce(() => new Promise<string>((res) => { releaseFirst = res }))
    h.loadRulesBlock.mockImplementation(async () => '<file path="SYSTEM.md">x</file>')
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessC'
    const p1 = mod.copyAndFill('q1')
    await flush()
    expect(releaseFirst, '第一次应已进入 prepend 挂起').not.toBeNull()
    const p2 = mod.copyAndFill('q2')
    await flush()
    releaseFirst!('<file path="SYSTEM.md">x</file>')
    await Promise.all([p1, p2])
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
  })

  it('单次调用正常注入一次', async () => {
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessD'
    await mod.copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(1)
  })

  it('投递失败时 pending 必须释放（下次调用仍可注入）', async () => {
    h.sendFillToAsync.mockResolvedValueOnce('failed')
    h.sendFillToAsync.mockResolvedValue('sent')
    vi.resetModules()
    const mod = await import('../composables/ai/useAiWindow')
    h.currentSession.value = 'sessE'
    await mod.copyAndFill('q1')
    await mod.copyAndFill('q1')
    expect(h.loadRulesBlock).toHaveBeenCalledTimes(2)
  })
})
