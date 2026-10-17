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

  it('源码断言：resetSessionContext 含 clearRulesCache 调用（静态反漏配）', () => {
    const src = fs.readFileSync(new URL('../composables/data/useWorkspaces.ts', import.meta.url), 'utf8')
    const i = src.indexOf('async function resetSessionContext')
    assert.ok(i > 0, 'resetSessionContext 缺失：模块结构已变，本守卫需同步')
    const tail = src.slice(i, i + 1200)
    assert.ok(/clearRulesCache/.test(tail), 'resetSessionContext 未调用 clearRulesCache：切工作区规则缓存不失效')
  })
})
