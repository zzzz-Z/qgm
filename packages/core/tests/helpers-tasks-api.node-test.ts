// [helpers-tasks-api-v1] 工单 D1 G4 守卫：__AI__.tasks API 异常不抛，返回 {ok:false, error}
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { afterEach, it } from 'vitest'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..', '..')
const HELPERS = path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs')

interface TasksApi {
  push: (items: string[]) => Promise<{ ok: boolean, todo?: number, done?: number, items?: number, running?: string, warnings?: string[], error?: string }>
  complete: (items: string[]) => Promise<{ ok: boolean, todo?: number, done?: number, items?: number, running?: string, warnings?: string[], error?: string }>
  // [tasks-list-v1] 读回当前看板
  list: () => Promise<{
    ok: boolean
    items?: Array<{ id?: string, desc?: string, status?: string }>
    todo?: string[]
    done?: unknown[]
    running?: string
    expiredRunning?: string[]
    failed?: string[]
    planPending?: number
    // [board-summary-v1] 汇总计数（防漏读 failed）
    summary?: { total: number, todo: number, running: number, done: number, failed: number, expiredRunning: number, planPending: number }
    error?: string
  }>
  // [task-board-fail-v1] 标记失败
  fail: (items: string[]) => Promise<{ ok: boolean, error?: string }>
}

const require = createRequire(import.meta.url)
require(HELPERS)
const api = (globalThis as unknown as { __AI__?: { tasks?: TasksApi } }).__AI__?.tasks

const origFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = origFetch })

it('G4: fetch 抛错 → 返回 {ok:false, error}，不抛断脚本', async () => {
  assert.ok(api, '__AI__.tasks 未导出')
  globalThis.fetch = (() => { throw new Error('boom') }) as unknown as typeof fetch
  const r = await api!.push(['A'])
  assert.equal(r.ok, false)
  assert.ok(typeof r.error === 'string' && r.error.length > 0)
})

it('G4: fetch reject → 返回 {ok:false, error}', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('net-down'))) as unknown as typeof fetch
  const r = await api!.complete(['A'])
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('net-down'))
})

it('G4: HTTP 500 → 返回 {ok:false, error: HTTP 500}', async () => {
  globalThis.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as unknown as typeof fetch
  const r = await api!.push(['A'])
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('500'))
})

it('G4: 200 + 正常体 → {ok:true, todo, done} 摘要', async () => {
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ todo: ['A', 'B'], done: ['X'] }) })) as unknown as typeof fetch
  const r = await api!.push(['A'])
  assert.equal(r.ok, true)
  assert.equal(r.todo, 2)
  assert.equal(r.done, 1)
})

it('D1: URL 拼接正确（端口从 AIR_SERVER_PORT 读，sid 从 env 拼到 query）', async () => {
  const origEnv = { ...process.env }
  process.env.AIR_SERVER_PORT = '8888'
  process.env.AI_RUNNER_SESSION_ID = 'sess-abc'
  let capturedUrl = ''
  let capturedBody = ''
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    capturedUrl = String(url)
    capturedBody = String(init?.body || '')
    return { ok: true, status: 200, json: async () => ({ todo: [], done: [] }) }
  }) as unknown as typeof fetch
  await api!.push(['T1', 'T2'])
  assert.ok(capturedUrl.includes('127.0.0.1:8888'), `端口未从 env 读: ${capturedUrl}`)
  assert.ok(capturedUrl.includes('/__ai/tasks'), `路径错: ${capturedUrl}`)
  assert.ok(capturedUrl.includes('sid=sess-abc'), `sid 未拼到 query: ${capturedUrl}`)
  assert.ok(capturedBody.includes('"mode":"push"'), `mode 错: ${capturedBody}`)
  assert.ok(capturedBody.includes('"pushTodo":["T1","T2"]'), `pushTodo 错: ${capturedBody}`)
  process.env = origEnv
})

it('D1: sid 为空 → URL 不带 query（回落全局桶，旧行为兼容）', async () => {
  const origEnv = { ...process.env }
  process.env.AIR_SERVER_PORT = '8888'
  delete process.env.AI_RUNNER_SESSION_ID
  let capturedUrl = ''
  globalThis.fetch = (async (url: string) => {
    capturedUrl = String(url)
    return { ok: true, status: 200, json: async () => ({ todo: [], done: [] }) }
  }) as unknown as typeof fetch
  await api!.push(['T1'])
  assert.ok(!capturedUrl.includes('?'), `sid 空时不该有 query: ${capturedUrl}`)
  process.env = origEnv
})

// [tasks-list-v1] 读回 API：AI 能看见自己的看板（旧实现只有写）
it('G5: list 返回结构化 items 与派生视图', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: [{ id: 'a1', desc: '任务甲', status: 'running' }, { id: 'b2', desc: '任务乙', status: 'done' }],
      todo: ['任务甲'],
      done: [{ item: '任务乙', at: 5 }],
      running: '任务甲',
      expiredRunning: ['旧运行项'],
      planPending: 2,
    }),
  })) as unknown as typeof fetch
  const r = await api!.list()
  assert.equal(r.ok, true)
  assert.equal(r.items?.length, 2)
  assert.equal(r.running, '任务甲')
  assert.deepEqual(r.expiredRunning, ['旧运行项'])
  assert.equal(r.planPending, 2)
})

// [board-summary-v1] 承重：failed 是独立数组，只看 todo/done/running 会漏读 → summary 必须直接暴露计数
it('G5b: list 返回 summary 汇总，failed/expiredRunning 计数可见（防漏读）', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      items: [
        { id: 'a1', desc: '任务甲', status: 'running' },
        { id: 'b2', desc: '任务乙', status: 'done' },
        { id: 'c3', desc: '任务丙', status: 'failed' },
      ],
      todo: [],
      done: [{ item: '任务乙', at: 5 }],
      running: '任务甲',
      expiredRunning: ['旧运行项'],
      failed: ['任务丙'],
      planPending: 0,
    }),
  })) as unknown as typeof fetch
  const r = await api!.list()
  assert.equal(r.ok, true)
  assert.equal(r.failed?.length, 1, 'failed 必须作为独立数组返回')
  assert.ok(r.summary, 'summary 必须存在（防只读 todo/done/running 漏掉失败项）')
  assert.equal(r.summary!.failed, 1, 'summary.failed 必须暴露失败项计数')
  assert.equal(r.summary!.expiredRunning, 1, 'summary.expiredRunning 必须暴露超时项计数')
  assert.equal(r.summary!.total, 3)
  assert.equal(r.summary!.done, 1)
})

it('G5: list 失败 → {ok:false, error}，不抛断脚本', async () => {
  globalThis.fetch = (() => Promise.reject(new Error('net-down'))) as unknown as typeof fetch
  const r = await api!.list()
  assert.equal(r.ok, false)
  assert.ok(String(r.error).includes('net-down'))
})

it('G4b: fail 走 mode=fail 且 URL/body 正确', async () => {
  const origEnv = { ...process.env }
  process.env.AIR_SERVER_PORT = '8888'
  process.env.AI_RUNNER_SESSION_ID = 'sess-f'
  let capturedUrl = ''
  let capturedBody = ''
  globalThis.fetch = (async (url: string, init: { body?: string }) => {
    capturedUrl = String(url)
    capturedBody = String(init?.body || '')
    return { ok: true, status: 200, json: async () => ({ todo: [], done: [] }) }
  }) as unknown as typeof fetch
  const r = await api!.fail(['坏任务'])
  assert.equal(r.ok, true)
  assert.ok(capturedUrl.includes('sid=sess-f'))
  assert.ok(capturedBody.includes('"mode":"fail"'), `mode 应为 fail: ${capturedBody}`)
  assert.ok(capturedBody.includes('"fail":["坏任务"]'))
  process.env = origEnv
})

it('G4b: push 返回附 items 计数与 running（AI 可自查看板）', async () => {
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ todo: ['A'], done: [], items: [{ id: 'x', desc: 'A' }], running: 'A', warnings: ['complete 未命中: Z'] }),
  })) as unknown as typeof fetch
  const r = await api!.push(['A'])
  assert.equal(r.items, 1)
  assert.equal(r.running, 'A')
  assert.deepEqual(r.warnings, ['complete 未命中: Z'])
})
