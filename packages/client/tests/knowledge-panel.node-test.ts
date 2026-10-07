// @vitest-environment happy-dom
// [kb-panel-v2] 三源知识库面板判据：lessons/docs 走本地端点（开箱即用），wiki 需外部 token。
// [WHY] v1 只接 wiki（恒 degraded），真正可用的 /lessons/match 未接——本文件守护 v2 的源切换与降级语义。
import { afterEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KnowledgePanel from '../components/panels/KnowledgePanel.vue'

const originalFetch = globalThis.fetch
interface Call { url: string, method: string, body: string }
let calls: Call[] = []

function mockFetch(handler: (url: string, method: string, body: string) => unknown) {
  calls = []
  globalThis.fetch = vi.fn(async (url: string, init?: { method?: string, body?: string }) => {
    const method = String(init?.method || 'GET')
    const body = String(init?.body || '')
    calls.push({ url: String(url), method, body })
    return { ok: true, json: async () => handler(String(url), method, body) }
  }) as unknown as typeof fetch
}

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks() })

test('默认源 lessons：检索走 POST /lessons/match 且 scope=lessons', async () => {
  mockFetch(() => ({ ok: true, matches: [{ title: '条目A', body: '正文A', state: 'verified' }] }))
  const w = mount(KnowledgePanel)
  await w.find('.kb-input').setValue('沙箱')
  await w.find('.kb-btn').trigger('click')
  await flushPromises()
  const call = calls.find(c => c.url.includes('/lessons/match'))
  expect(call, '必须调 /lessons/match').toBeTruthy()
  expect(call!.body).toContain('"scope":"lessons"')
  expect(w.find('.kb-hit-title').text()).toContain('条目A')
  w.unmount()
})

test('切到 docs 源：scope=docs', async () => {
  mockFetch(() => ({ ok: true, matches: [{ title: 'DESIGN.md › 布局', src: 'docs/DESIGN.md' }] }))
  const w = mount(KnowledgePanel)
  await w.findAll('.kb-src')[1].trigger('click')
  await w.find('.kb-input').setValue('布局')
  await w.find('.kb-btn').trigger('click')
  await flushPromises()
  const call = calls.find(c => c.url.includes('/lessons/match'))
  expect(call!.body).toContain('"scope":"docs"')
  expect(w.find('.kb-path').text()).toContain('docs/DESIGN.md')
  w.unmount()
})

test('切到 wiki 源：degraded ⇒ 渲染「离线」而非空命中', async () => {
  mockFetch(() => ({ ok: false, degraded: true, reason: 'LLM_WIKI_TOKEN 未配置' }))
  const w = mount(KnowledgePanel)
  await w.findAll('.kb-src')[2].trigger('click')
  await flushPromises()
  expect(w.find('.kb-status').text()).toContain('离线')
  w.unmount()
})

test('本地源空命中：显示「无命中」而非离线', async () => {
  mockFetch(() => ({ ok: true, matches: [] }))
  const w = mount(KnowledgePanel)
  await w.find('.kb-input').setValue('zzz')
  await w.find('.kb-btn').trigger('click')
  await flushPromises()
  expect(w.find('.kb-empty').text()).toContain('无命中')
  expect(w.find('.kb-offline').exists()).toBe(false)
  w.unmount()
})
