// @vitest-environment happy-dom
// [wiki-panel-v1] 段二判据：离线态必须渲染「离线」，不得渲染成空列表。
// [WHY] 空列表会让用户误判为「知识库里没有」，与「没启动」不可分——本项目一贯要求的可判据降级。
import { afterEach, expect, test, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import KnowledgePanel from '../components/panels/KnowledgePanel.vue'

const originalFetch = globalThis.fetch

function mockFetch(handler: (url: string) => unknown) {
  globalThis.fetch = vi.fn(async (url: string) => ({
    ok: true,
    json: async () => handler(String(url)),
  })) as unknown as typeof fetch
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

test('在线：health ok ⇒ 渲染「在线」', async () => {
  mockFetch(() => ({ ok: true, degraded: false }))
  const w = mount(KnowledgePanel)
  await flushPromises()
  expect(w.find('.kb-status').text()).toContain('在线')
  w.unmount()
})

test('离线：health degraded ⇒ 渲染「离线」而非空列表（变异：渲染空列表必红）', async () => {
  mockFetch(() => ({ ok: false, degraded: true, reason: 'LLM_WIKI_TOKEN 未配置' }))
  const w = mount(KnowledgePanel)
  await flushPromises()
  const txt = w.find('.kb-status').text()
  expect(txt).toContain('离线')
  expect(txt).toContain('LLM_WIKI_TOKEN 未配置')
  expect(w.find('.kb-hits').exists()).toBe(false)
  w.unmount()
})

test('检索降级：search 返回 degraded ⇒ 状态转离线，不显示空命中', async () => {
  mockFetch((url) => {
    if (url.includes('/health')) return { ok: true, degraded: false }
    return { ok: false, degraded: true, reason: 'TimeoutError' }
  })
  const w = mount(KnowledgePanel)
  await flushPromises()
  await w.find('.kb-input').setValue('foo')
  await w.find('.kb-btn').trigger('click')
  await flushPromises()
  expect(w.find('.kb-status').text()).toContain('离线')
  expect(w.find('.kb-empty').exists()).toBe(false)
  w.unmount()
})

test('命中：search 返回 results ⇒ 渲染路径与片段', async () => {
  mockFetch((url) => {
    if (url.includes('/health')) return { ok: true, degraded: false }
    return { ok: true, degraded: false, results: [{ path: 'a/b.md', snippet: '片段X' }] }
  })
  const w = mount(KnowledgePanel)
  await flushPromises()
  await w.find('.kb-input').setValue('kw')
  await w.find('.kb-btn').trigger('click')
  await flushPromises()
  expect(w.find('.kb-path').text()).toContain('a/b.md')
  expect(w.find('.kb-snippet').text()).toContain('片段X')
  w.unmount()
})
