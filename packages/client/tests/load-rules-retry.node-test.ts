// [empty-cache-fix-guard-v1] 承重判据：SYSTEM.md 加载失败时**不得缓存空结果**，下次调用必须重新请求。
// [WHY] 旧实现 catch 内静默 return '' → 外层 Promise 正常 resolve → _rulesPromise.catch 不触发 →
//   空结果被永久缓存 ⇒ 启动早期一次失败后本标签页内「新会话窗口不加载系统提示词」（用户可见症状）。
// [VARIANT] 变异验证：把失败分支改回 return '' 不清缓存 → 用例第二段 expect(callCount).toBe(2) 必红。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRulesCache, loadRulesBlock } from '../composables/ai/load-rules.js'

function jsonRes(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })
}

describe('load-rules 失败不缓存（empty-cache-fix-v1）', () => {
  beforeEach(() => clearRulesCache())

  it('SYSTEM.md 首次 500 → 结果不含规则；第二次 200 → 重新请求并带上规则', async () => {
    let systemCalls = 0
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const u = String(typeof url === 'string' ? url : (url as URL | Request).toString())
      if (u.includes('/__ai/preset/system')) {
        systemCalls++
        if (systemCalls === 1) return new Response('boom', { status: 500 })
        return jsonRes({ ok: true, content: 'SYS-CONTENT' })
      }
      if (u.includes('/__ai/files/read')) return jsonRes({ files: [] })
      throw new Error(`unexpected url: ${u}`)
    })

    const first = await loadRulesBlock()
    expect(first).not.toContain('SYS-CONTENT')
    expect(systemCalls).toBe(1)

    const second = await loadRulesBlock()
    expect(second).toContain('SYS-CONTENT')
    expect(systemCalls).toBe(2)

    vi.unstubAllGlobals()
  })

  it('全部成功 → 结果被缓存，第二次调用不再请求', async () => {
    let systemCalls = 0
    vi.stubGlobal('fetch', async (url: string | URL | Request) => {
      const u = String(typeof url === 'string' ? url : (url as URL | Request).toString())
      if (u.includes('/__ai/preset/system')) {
        systemCalls++
        return jsonRes({ ok: true, content: 'SYS-CONTENT' })
      }
      if (u.includes('/__ai/files/read')) return jsonRes({ files: [] })
      throw new Error(`unexpected url: ${u}`)
    })

    const a = await loadRulesBlock()
    const b = await loadRulesBlock()
    expect(a).toContain('SYS-CONTENT')
    expect(b).toContain('SYS-CONTENT')
    expect(systemCalls).toBe(1)

    vi.unstubAllGlobals()
  })
})
