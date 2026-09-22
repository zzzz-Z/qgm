import { test } from 'vitest'
import assert from 'node:assert/strict'
import { syncTasks } from '../composables/data/useTaskSync.ts'

// AIRUNNER-BATCH17-2-USE-TASK-SYNC

interface Captured { url: string, init: RequestInit | undefined }

function withMockFetch(handler: (c: Captured) => Promise<Response> | Response): { captured: Captured[], restore: () => void } {
  const captured: Captured[] = []
  const orig = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
    const c: Captured = { url, init }
    captured.push(c)
    return await handler(c)
  }) as typeof fetch
  return { captured, restore: () => { globalThis.fetch = orig } }
}

test('syncTasks: 向 /__ai/tasks POST', async () => {
  const { captured, restore } = withMockFetch(() => new Response('', { status: 200 }))
  try {
    await syncTasks({ mode: 'set', todo: ['a', 'b'] })
    assert.equal(captured.length, 1)
    assert.equal(captured[0].url, '/__ai/tasks')
    assert.equal(captured[0].init?.method, 'POST')
  } finally { restore() }
})

test('syncTasks: 请求头包含 application/json', async () => {
  const { captured, restore } = withMockFetch(() => new Response('', { status: 200 }))
  try {
    await syncTasks({ mode: 'push', pushTodo: ['x'] })
    const h = (captured[0].init?.headers || {}) as Record<string, string>
    assert.equal(h['content-type'], 'application/json')
    assert.equal(h.accept, 'application/json')
  } finally { restore() }
})

test('syncTasks: body 为 JSON.stringify 后的输入', async () => {
  const { captured, restore } = withMockFetch(() => new Response('', { status: 200 }))
  try {
    const body = { mode: 'set' as const, todo: ['t1'], round: 7 }
    await syncTasks(body)
    assert.equal(captured[0].init?.body, JSON.stringify(body))
  } finally { restore() }
})

test('syncTasks: cache 使用 no-store', async () => {
  const { captured, restore } = withMockFetch(() => new Response('', { status: 200 }))
  try {
    await syncTasks({})
    assert.equal(captured[0].init?.cache, 'no-store')
  } finally { restore() }
})

test('syncTasks: fetch 抛错时静默（不向调用方抛）', async () => {
  const { restore } = withMockFetch(() => { throw new Error('network down') })
  try {
    await assert.doesNotReject(async () => { await syncTasks({ mode: 'set' }) })
  } finally { restore() }
})

test('syncTasks: fetch reject 时静默', async () => {
  const { restore } = withMockFetch(() => Promise.reject(new Error('reject')))
  try {
    await assert.doesNotReject(async () => { await syncTasks({}) })
  } finally { restore() }
})

test('syncTasks: 空对象调用也发一次请求', async () => {
  const { captured, restore } = withMockFetch(() => new Response('', { status: 200 }))
  try {
    await syncTasks({})
    assert.equal(captured.length, 1)
    assert.equal(captured[0].init?.body, '{}')
  } finally { restore() }
})

test('syncTasks: done 数组被 JSON 化', async () => {
  const { captured, restore } = withMockFetch(() => new Response('', { status: 200 }))
  try {
    const body = { done: [{ item: 'task', at: 12345, round: 3, note: 'ok' }] }
    await syncTasks(body)
    const sent = JSON.parse(String(captured[0].init?.body))
    assert.deepEqual(sent, body)
  } finally { restore() }
})

test('syncTasks: HTTP 500 也不抛错（当前实现不检查 status）', async () => {
  const { restore } = withMockFetch(() => new Response('oops', { status: 500 }))
  try {
    await assert.doesNotReject(async () => { await syncTasks({ mode: 'set' }) })
  } finally { restore() }
})
