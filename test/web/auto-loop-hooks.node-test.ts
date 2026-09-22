import { test } from 'vitest'
import assert from 'node:assert/strict'
import { runHook } from '../../client/composables/ai/auto-loop/hooks.ts'

// AIRUNNER-BATCH34-2-AUTO-LOOP-HOOKS

interface FetchCall { url: string, init: RequestInit | undefined }
let calls: FetchCall[] = []
let fetchImpl: (c: FetchCall) => Promise<Response> | Response = () => new Response(JSON.stringify({ event: 'LoopStop', action: 'ok', hooksRun: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })

const origFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url
  const c: FetchCall = { url, init }
  calls.push(c)
  return await fetchImpl(c)
}) as typeof fetch

function reset() {
  calls = []
  fetchImpl = () => new Response(JSON.stringify({ event: 'LoopStop', action: 'ok', hooksRun: 0 }), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('runHook: POST /__ai/hooks/run', async () => {
  reset()
  await runHook('BeforeFill', { x: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/__ai/hooks/run')
  assert.equal(calls[0].init?.method, 'POST')
})

test('runHook: Content-Type 为 application/json', async () => {
  reset()
  await runHook('BeforeFill', {})
  const h = (calls[0].init?.headers || {}) as Record<string, string>
  assert.equal(h['Content-Type'], 'application/json')
})

test('runHook: body 为 { event, payload } JSON', async () => {
  reset()
  await runHook('AfterScript', { y: 2 })
  const body = JSON.parse(String(calls[0].init?.body))
  assert.equal(body.event, 'AfterScript')
  assert.deepEqual(body.payload, { y: 2 })
})

test('runHook: 200 响应透传 JSON 结果', async () => {
  reset()
  fetchImpl = () => new Response(JSON.stringify({ event: 'BeforeScript', action: 'reject', reason: 'x', hooksRun: 3 }), { status: 200, headers: { 'content-type': 'application/json' } })
  const r = await runHook('BeforeScript', {})
  assert.equal(r.action, 'reject')
  assert.equal(r.reason, 'x')
  assert.equal(r.hooksRun, 3)
})

test('runHook: 非 2xx 响应 → 默认 { action: ok, hooksRun: 0 }', async () => {
  reset()
  fetchImpl = () => new Response('err', { status: 500 })
  const r = await runHook('LoopStop', {})
  assert.equal(r.action, 'ok')
  assert.equal(r.hooksRun, 0)
  assert.equal(r.event, 'LoopStop')
})

test('runHook: fetch 抛错 → 默认 { action: ok, hooksRun: 0 }', async () => {
  reset()
  fetchImpl = () => Promise.reject(new Error('offline'))
  const r = await runHook('AfterResult', {})
  assert.equal(r.action, 'ok')
  assert.equal(r.hooksRun, 0)
})

test('runHook: 5 种 HookEvent 均可调用', async () => {
  reset()
  const events = ['BeforeFill', 'BeforeScript', 'AfterScript', 'AfterResult', 'LoopStop'] as const
  for (const ev of events) {
    await runHook(ev, {})
  }
  assert.equal(calls.length, 5)
})

test('runHook: payload 为任意结构均可序列化', async () => {
  reset()
  await runHook('BeforeFill', { nested: { a: [1, 2, 3] }, s: 'str' })
  const body = JSON.parse(String(calls[0].init?.body))
  assert.deepEqual(body.payload, { nested: { a: [1, 2, 3] }, s: 'str' })
})

// 清理（进程结束前恢复 fetch）
process.on('beforeExit', () => { globalThis.fetch = origFetch })
