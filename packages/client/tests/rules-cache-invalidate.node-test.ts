// [rules-cache-invalidate-v1] 切/建/删工作区必须失效 load-rules 的模块级 Promise 缓存。
// [WHY] load-rules 的缓存与 root 无关：不清则新工作区首问仍带上一工作区的 AGENTS.md（用户报告）。
// [承重] 变异验证：删掉 useWorkspaces.resetSessionContext 里的 clearRulesCache() 调用 → 用例必红。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'

import { useWorkspaces } from '../composables/data/useWorkspaces'

const { clearRulesCache } = vi.hoisted(() => ({ clearRulesCache: vi.fn() }))
vi.mock('../composables/ai/load-rules', () => ({
  clearRulesCache,
  loadRulesParts: vi.fn(),
  loadRulesBlock: vi.fn(),
}))
vi.mock('../composables/ai/useSessionManager', () => ({ useSessionManager: () => ({ resetSession: vi.fn() }) }))
vi.mock('../composables/ui/useEventStream', () => ({ clearEvents: vi.fn() }))
vi.mock('../composables/runner/useScriptInbox', () => ({ clearInbox: vi.fn() }))

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 })

describe('rules-cache-invalidate-v1：切工作区必须失效 SYSTEM.md / AGENTS.md 的 Promise 缓存', () => {
  const origFetch = globalThis.fetch
  beforeEach(() => { clearRulesCache.mockClear() })
  afterEach(() => { globalThis.fetch = origFetch })

  it('register(activate=true) → clearRulesCache 被调用', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const s = String(url)
      if (s.includes('/workspace/register')) return okJson({ ok: true, workspace: { id: 'b', root: '/b', label: 'B', addedAt: 0 } })
      if (s.includes('/workspace/registry')) return okJson({ workspaces: [{ id: 'b', root: '/b', label: 'B', addedAt: 0 }], activeId: 'b' })
      return okJson({ ok: true })
    }) as unknown as typeof fetch
    const { register } = useWorkspaces()
    const r = await register('/b', true)
    assert.equal(r.ok, true)
    assert.equal(clearRulesCache.mock.calls.length >= 1, true, '切工作区未清规则缓存：新工作区首问会带上一工作区的 AGENTS.md')
  })

  it('remove(active) → clearRulesCache 被调用（服务端已回退 root）', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const s = String(url)
      if (s.includes('/workspace/remove')) return okJson({ ok: true, activeId: null })
      if (s.includes('/workspace/registry')) return okJson({ workspaces: [{ id: 'b', root: '/b', label: 'B', addedAt: 0 }], activeId: 'b' })
      return okJson({ ok: true })
    }) as unknown as typeof fetch
    const { load, remove } = useWorkspaces()
    await load()
    clearRulesCache.mockClear()
    const r = await remove('b')
    assert.equal(r.ok, true)
    assert.equal(clearRulesCache.mock.calls.length >= 1, true, '删活跃工作区未清规则缓存')
  })

  it('load() 纯读取不失效缓存（防误清 / 防止把判据改成恒真）', async () => {
    globalThis.fetch = vi.fn(async () => okJson({ workspaces: [], activeId: null })) as unknown as typeof fetch
    const { load } = useWorkspaces()
    await load()
    assert.equal(clearRulesCache.mock.calls.length, 0, 'load 不得清规则缓存：仅真正改变 root 的路径才自增 epoch / 清缓存')
  })

  it('applyRootChanged 含 clearRulesCache + bumpWorkspaceEpoch（静态反漏配）', () => {
    const s = fs.readFileSync(new URL('../composables/data/useWorkspaces.ts', import.meta.url), 'utf8')
    const i = s.indexOf('async function applyRootChanged')
    assert.ok(i > 0, 'applyRootChanged 缺失：模块结构已变，本守卫需同步')
    const tail = s.slice(i, i + 1600)
    assert.ok(/clearRulesCache/.test(tail), 'applyRootChanged 未清规则缓存：首问仍带上一工作区 AGENTS.md')
    assert.ok(/bumpWorkspaceEpoch\(\)/.test(tail), 'applyRootChanged 未自增 epoch：面板停在旧 root')
  })

  // [workspace-root-single-exit-v1] 四路 root 变更必须全部经由单一出口。
  // [承重] 任一入口改回内联副作用，或新增入口绕开该函数 → 用例必红。
  it('四路 root 变更全部汇聚 applyRootChanged，且无残留旧函数名', () => {
    const s = fs.readFileSync(new URL('../composables/data/useWorkspaces.ts', import.meta.url), 'utf8')
    assert.ok(!/resetSessionContext/.test(s), '残留旧名 resetSessionContext')
    for (const fn of ['activate', 'register', 'remove', 'create']) {
      const a = s.indexOf(`async function ${fn}(`)
      assert.ok(a > 0, `未找到入口函数 ${fn}`)
      const b = s.indexOf('\nasync function ', a + 1)
      const body = s.slice(a, b > 0 ? b : s.length)
      const hits = (body.match(/await applyRootChanged\(\)/g) || []).length
      assert.equal(hits, 1, `${fn} 未汇聚单一出口（命中 ${hits} 次）`)
      assert.ok(!/bumpWorkspaceEpoch\(\)/.test(body), `${fn} 内联了 epoch 自增`)
    }
  })
})
