// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useFileTree.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useFileTree.node-test.ts 迁至 test/useFileTree.node-test.ts
import { beforeAll as before, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH17-9-USE-FILE-TREE

const g = globalThis as Record<string, unknown>

interface FetchCall { url: string }
let calls: FetchCall[] = []
let fetchImpl: (c: FetchCall) => Promise<Response> | Response = () => new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { 'content-type': 'application/json' } })

g.fetch = (async (input: string | URL | Request) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
  const c: FetchCall = { url }
  calls.push(c)
  return await fetchImpl(c)
}) as typeof fetch

// navigator.clipboard mock
let clipboardWrites: string[] = []
let clipboardShouldFail = false
// AIRUNNER-BATCH17-9-FIX-NAVIGATOR: Node 内建 navigator 为只读 getter，改用 defineProperty
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    clipboard: {
      writeText: async (p: string): Promise<void> => {
        if (clipboardShouldFail) throw new Error('denied')
        clipboardWrites.push(p)
      },
    },
  },
})

let useFileTree: typeof import('../../packages/client/composables/data/useFileTree.ts').useFileTree

before(async () => {
  const mod = await import('../../packages/client/composables/data/useFileTree.ts')
  useFileTree = mod.useFileTree
})

beforeEach(() => {
  // AIRUNNER-BATCH21-6-MOVE-TIMERS: 移入 hook
  vi.useFakeTimers()
  calls = []
  clipboardWrites = []
  clipboardShouldFail = false
  fetchImpl = () => new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  vi.useFakeTimers()
  vi.useFakeTimers()
})

test('useFileTree: 返回完整 API', () => {
  const r = useFileTree()
  for (const k of ['tree', 'loading', 'copiedPath', 'loadingChildren', 'load', 'loadChildren', 'getChildren', 'isChildrenLoading', 'copyPath'] as const) {
    assert.ok(k in r, `missing key: ${k}`)
  }
})

test('load: 向 /__ai/files?depth=1 发请求并填充 tree', async () => {
  fetchImpl = () => new Response(JSON.stringify({ tree: [{ path: 'a.ts', type: 'file' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useFileTree()
  await r.load()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/__ai/files?depth=1')
  assert.equal(r.tree.value.length, 1)
  assert.equal(r.tree.value[0].path, 'a.ts')
  assert.equal(r.loading.value, false)
})

test('load: 请求结束后 loading 复位', async () => {
  const r = useFileTree()
  await r.load()
  assert.equal(r.loading.value, false)
})

test('load: data.tree 缺失 → tree 为空数组', async () => {
  fetchImpl = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useFileTree()
  await r.load()
  assert.deepEqual(r.tree.value, [])
})

test('loadChildren: 首次拉取并写入缓存', async () => {
  fetchImpl = (c) => {
    if (c.url.startsWith('/__ai/files/children'))
      return new Response(JSON.stringify({ children: [{ path: 'sub/x.ts', type: 'file' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const r = useFileTree()
  await r.loadChildren('src')
  const kids = r.getChildren('src')
  assert.equal(kids.length, 1)
  assert.equal(kids[0].path, 'sub/x.ts')
})

test('loadChildren: path 被 URL encode', async () => {
  const r = useFileTree()
  await r.loadChildren('a b/c')
  const url = calls.find(c => c.url.startsWith('/__ai/files/children'))!.url
  assert.ok(url.includes('path=a%20b%2Fc'), `url=${url}`)
})

test('loadChildren: 二次调用命中缓存，不发请求', async () => {
  fetchImpl = () => new Response(JSON.stringify({ children: [{ path: 'x', type: 'file' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useFileTree()
  await r.loadChildren('p1')
  const n = calls.length
  await r.loadChildren('p1')
  assert.equal(calls.length, n)
})

test('loadChildren: fetch 抛错 → 缓存写空数组（不冒泡）', async () => {
  fetchImpl = () => Promise.reject(new Error('offline'))
  const r = useFileTree()
  await assert.doesNotReject(() => r.loadChildren('bad'))
  assert.deepEqual(r.getChildren('bad'), [])
})

test('isChildrenLoading: 请求进行中返回 true，结束后 false', async () => {
  // AIRUNNER-BATCH17-9-FIX-RESOLVE: definite assignment 避免 TS 收窄
  let resolveFetch!: (r: Response) => void
  fetchImpl = () => new Promise<Response>((res) => { resolveFetch = res })
  const r = useFileTree()
  const p = r.loadChildren('pending')
  assert.equal(r.isChildrenLoading('pending'), true)
  resolveFetch(new Response(JSON.stringify({ children: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))
  await p
  assert.equal(r.isChildrenLoading('pending'), false)
})

test('getChildren: 未加载路径返回空数组', () => {
  const r = useFileTree()
  assert.deepEqual(r.getChildren('never'), [])
})

test('copyPath: 写入剪贴板并设置 copiedPath', async () => {
  const r = useFileTree()
  await r.copyPath('src/foo.ts')
  assert.deepEqual(clipboardWrites, ['src/foo.ts'])
  assert.equal(r.copiedPath.value, 'src/foo.ts')
})

test('copyPath: 剪贴板拒绝 → 静默（copiedPath 不变）', async () => {
  clipboardShouldFail = true
  const r = useFileTree()
  const prev = r.copiedPath.value
  await assert.doesNotReject(() => r.copyPath('x'))
  assert.equal(r.copiedPath.value, prev)
})

test('copyPath: 1200ms 后 copiedPath 被清空', async () => {
  const r = useFileTree()
  await r.copyPath('a')
  assert.equal(r.copiedPath.value, 'a')
  vi.advanceTimersByTime(1200)
  assert.equal(r.copiedPath.value, '')
})

test('load: 会清空 childrenCache（新树刷新）', async () => {
  fetchImpl = (c) => {
    if (c.url.startsWith('/__ai/files/children'))
      return new Response(JSON.stringify({ children: [{ path: 'a', type: 'file' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ tree: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const r = useFileTree()
  await r.loadChildren('q')
  assert.equal(r.getChildren('q').length, 1)
  await r.load()
  assert.deepEqual(r.getChildren('q'), [])
})
