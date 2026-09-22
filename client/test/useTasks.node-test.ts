import { beforeAll as before, test } from 'vitest'
import assert from 'node:assert/strict'

// AIRUNNER-BATCH17-8-USE-TASKS
// vue 的 onMounted / onBeforeUnmount 在无组件上下文时只 warn，不抛错。
// 因此直接 useTasks() 后手动调用 refresh() 即可测状态机。

const g = globalThis as Record<string, unknown>

interface FetchCall { url: string, init: RequestInit | undefined }
let calls: FetchCall[] = []
let fetchImpl: (call: FetchCall) => Promise<Response> | Response = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })

// AIRUNNER-BATCH17-8-FIX-ORIG-FETCH: 不保存 origFetch；测试进程结束后退出，无需恢复
g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
  const c: FetchCall = { url, init }
  calls.push(c)
  return await fetchImpl(c)
}) as typeof fetch

let useTasks: typeof import('../composables/data/useTasks.ts').useTasks

before(async () => {
  const mod = await import('../composables/data/useTasks.ts')
  useTasks = mod.useTasks
})

function reset() {
  calls = []
  fetchImpl = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}

test('useTasks: 初始状态为 EMPTY', () => {
  reset()
  const r = useTasks()
  assert.deepEqual(r.state.value, { round: 0, status: 'unknown', todo: [], done: [] })
  assert.equal(r.lastUpdated.value, 0)
  assert.equal(r.lastError.value, '')
})

test('refresh: 向 /__ai/tasks 发送 GET（accept: application/json）', async () => {
  reset()
  const r = useTasks()
  await r.refresh()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/__ai/tasks')
  const h = (calls[0].init?.headers || {}) as Record<string, string>
  assert.equal(h.accept, 'application/json')
  assert.equal(calls[0].init?.cache, 'no-store')
})

test('refresh: 成功响应解析为 state', async () => {
  reset()
  fetchImpl = () => new Response(JSON.stringify({
    round: 5,
    status: 'running',
    todo: ['a', 'b'],
    done: [{ item: 'x', at: 100, round: 1 }],
    doneAt: 999,
  }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useTasks()
  await r.refresh()
  assert.equal(r.state.value.round, 5)
  assert.equal(r.state.value.status, 'running')
  assert.deepEqual(r.state.value.todo, ['a', 'b'])
  assert.equal(r.state.value.done.length, 1)
  assert.equal(r.state.value.doneAt, 999)
  assert.equal(r.lastError.value, '')
  assert.ok(r.lastUpdated.value > 0)
})

test('refresh: HTTP 500 → lastError = HTTP 500，state 不变', async () => {
  reset()
  fetchImpl = () => new Response('err', { status: 500 })
  const r = useTasks()
  await r.refresh()
  assert.equal(r.lastError.value, 'HTTP 500')
  assert.equal(r.state.value.status, 'unknown')
  assert.equal(r.lastUpdated.value, 0)
})

test('refresh: 网络错误 → lastError 记录 message', async () => {
  reset()
  fetchImpl = () => Promise.reject(new Error('network down'))
  const r = useTasks()
  await r.refresh()
  assert.equal(r.lastError.value, 'network down')
})

test('refresh: 非对象 JSON（null）→ 不改 state', async () => {
  reset()
  fetchImpl = () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useTasks()
  await r.refresh()
  assert.equal(r.state.value.status, 'unknown')
})

test('refresh: 缺字段时用默认值（round=0 / status=unknown / todo=[]）', async () => {
  reset()
  fetchImpl = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useTasks()
  await r.refresh()
  assert.equal(r.state.value.round, 0)
  assert.equal(r.state.value.status, 'unknown')
  assert.deepEqual(r.state.value.todo, [])
  assert.deepEqual(r.state.value.done, [])
})

test('refresh: todo 元素被 String 化', async () => {
  reset()
  fetchImpl = () => new Response(JSON.stringify({ todo: [1, true, 'x'] }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useTasks()
  await r.refresh()
  assert.deepEqual(r.state.value.todo, ['1', 'true', 'x'])
})

test('refresh: done 非数组时归零', async () => {
  reset()
  fetchImpl = () => new Response(JSON.stringify({ done: 'oops' }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = useTasks()
  await r.refresh()
  assert.deepEqual(r.state.value.done, [])
})

test('refresh: 连续两次调用只在完成前一次后第二次才发新请求（inflight）', async () => {
  reset()
  // AIRUNNER-BATCH17-8-FIX-RESOLVE: definite assignment 避免 TS 收窄为 null
  let resolveFetch!: (r: Response) => void
  fetchImpl = () => new Promise<Response>((res) => { resolveFetch = res })
  const r = useTasks()
  const p1 = r.refresh()
  const p2 = r.refresh()
  // 第二次应被 inflight 短路（不再发请求）
  assert.equal(calls.length, 1)
  resolveFetch(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }))
  await Promise.all([p1, p2])
  assert.equal(calls.length, 1)
})

test('refresh: 成功后 lastError 清空', async () => {
  reset()
  fetchImpl = () => new Response('err', { status: 500 })
  const r = useTasks()
  await r.refresh()
  assert.equal(r.lastError.value, 'HTTP 500')
  fetchImpl = () => new Response(JSON.stringify({ round: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  await r.refresh()
  assert.equal(r.lastError.value, '')
  assert.equal(r.state.value.round, 1)
})
