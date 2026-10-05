// [cumulative-baseline-v1] 变更视图（本轮 / 累积）与「回滚归属」的契约守卫
// WHY: 累积视图最容易出的两类静默错误是——①切换后不加载（面板停在旧累计）；
//      ②回滚仍用本轮 runId（服务端 400，用户以为撤了其实没撤）。两者都不报错，故锁成测试。
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'

// ===== 全局 storage / window 桩（与 useRunner.node-test.ts 同构；vueuse 需要它们）=====
const lsStore = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string): string | null => (lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: (k: string, v: string): void => { lsStore.set(k, String(v)) },
    removeItem: (k: string): void => { lsStore.delete(k) },
    clear: (): void => { lsStore.clear() },
    key: (i: number): string | null => Array.from(lsStore.keys())[i] ?? null,
    get length(): number { return lsStore.size },
  },
})

const ssStore = new Map<string, string>()
class StorageStub { }
Object.defineProperty(globalThis, 'Storage', { configurable: true, writable: true, value: StorageStub })
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  writable: true,
  value: {
    getItem: (k: string): string | null => (ssStore.has(k) ? ssStore.get(k)! : null),
    setItem: (k: string, v: string): void => { ssStore.set(k, String(v)) },
    removeItem: (k: string): void => { ssStore.delete(k) },
    clear: (): void => { ssStore.clear() },
    key: (i: number): string | null => Array.from(ssStore.keys())[i] ?? null,
    get length(): number { return ssStore.size },
  },
})
;(globalThis as unknown as { document: unknown }).document = { createElement: () => ({ style: {} }), addEventListener: () => {}, removeEventListener: () => {} }
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  writable: true,
  value: {
    location: { href: 'http://localhost/' },
    get localStorage() { return globalThis.localStorage },
    get sessionStorage() { return globalThis.sessionStorage },
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    // [storage-write-event] vueuse useStorage 写入后会 window.dispatchEvent(CustomEvent)
    // 广播跨标签页变更；缺失时每个用例都会打印 TypeError 噪音（掩盖真实异常）
    dispatchEvent: (): boolean => true,
  },
})

// ===== fetch 桩：记录调用，按 url 分派响应 =====
interface FetchCall {
  url: string
  body: Record<string, unknown>
}
let calls: FetchCall[] = []
let diffReply: unknown = { baselineRunId: 'R1', changes: [] }
let rollbackReply: unknown = { ok: true }
let fetchThrows = false

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
  calls.push({ url, body })
  if (fetchThrows) throw new Error('network down')
  const payload = url.includes('/diff-from-baseline')
    ? diffReply
    : url.includes('/rollback')
      ? rollbackReply
      : {}
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

let mod: typeof import('../../../packages/client/composables/runner/useRunner')
beforeAll(async () => {
  mod = await import('../../../packages/client/composables/runner/useRunner')
})

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
  calls = []
  fetchThrows = false
  diffReply = { baselineRunId: 'R1', changes: [] }
  rollbackReply = { ok: true }
  // 模块单例：每个用例都从干净状态起
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = ''
  r.changeView.value = 'round'
  r.cumulativeChanges.value = []
  r.cumulativeError.value = ''
  r.changes.value = []
  r.result.value = null
})

/** 取第一次命中的调用（找不到即断言失败，避免后续 undefined 静默通过） */
function findCall(fragment: string): FetchCall {
  const hit = calls.find(c => c.url.includes(fragment))
  assert.ok(hit, `未发出请求：${fragment}；实际 ${JSON.stringify(calls.map(c => c.url))}`)
  return hit
}

test('无会话基准：切到累积不发请求，列表为空且无错', async () => {
  const r = mod.useRunner()
  await r.setChangeView('cumulative')
  assert.equal(calls.length, 0)
  assert.deepEqual(r.cumulativeChanges.value, [])
  assert.equal(r.cumulativeError.value, '')
})

test('切到累积：请求带 mode=before + withOwner，可见口径随之切换', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  diffReply = { baselineRunId: 'R1', changes: [{ path: 'a.ts', type: 'modified', runId: 'R1', rollbackable: true }] }
  r.changes.value = [{ path: 'z.ts', type: 'added' }]

  await r.setChangeView('cumulative')

  const call = findCall('/diff-from-baseline')
  assert.equal(call.body.baselineRunId, 'R1')
  // mode 必须是 before：用 after 会漏掉基准轮自身的改动，累积口径从第一轮起就是错的
  assert.equal(call.body.mode, 'before')
  assert.equal(call.body.withOwner, true)
  assert.deepEqual(r.cumulativeChanges.value.map(c => c.path), ['a.ts'])
  assert.deepEqual(r.visibleChanges.value.map(c => c.path), ['a.ts'])
  assert.equal(r.cumulativeError.value, '')
})

test('切回本轮：不再发请求，可见口径回到本轮增量', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  diffReply = { baselineRunId: 'R1', changes: [{ path: 'a.ts', type: 'modified', runId: 'R1' }] }
  await r.setChangeView('cumulative')
  r.changes.value = [{ path: 'z.ts', type: 'added' }]

  const before = calls.length
  await r.setChangeView('round')

  assert.equal(calls.length, before)
  assert.deepEqual(r.visibleChanges.value.map(c => c.path), ['z.ts'])
})

test('回滚用条目自带 runId，而不是本轮 runId', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  r.result.value = { runId: 'RCUR' } as never
  diffReply = { baselineRunId: 'R1', changes: [{ path: 'a.ts', type: 'modified', runId: 'R1', rollbackable: true }] }
  await r.setChangeView('cumulative')

  const data = await r.rollback('a.ts')

  assert.equal(data?.ok, true)
  const call = findCall('/__ai/rollback')
  assert.equal(call.body.runId, 'R1')
  assert.equal(call.body.file, 'a.ts')
  assert.deepEqual(r.cumulativeChanges.value, [])
})

test('本轮视图：条目无 runId 时回落本轮 runId', async () => {
  const r = mod.useRunner()
  r.result.value = { runId: 'RCUR' } as never
  r.changeView.value = 'round'
  r.changes.value = [{ path: 'a.ts', type: 'modified' }]

  await r.rollback('a.ts')

  assert.equal(findCall('/__ai/rollback').body.runId, 'RCUR')
})

test('累积视图下「撤回全部」逐条按各自归属轮回滚，不能只撤本轮', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  r.result.value = { runId: 'RCUR' } as never
  diffReply = {
    baselineRunId: 'R1',
    changes: [
      { path: 'a.ts', type: 'modified', runId: 'R1', rollbackable: true },
      { path: 'b.ts', type: 'added', runId: 'R2', rollbackable: true },
    ],
  }
  await r.setChangeView('cumulative')

  const data = await r.rollbackAll()

  const used = calls.filter(c => c.url.includes('/__ai/rollback')).map(c => String(c.body.runId)).sort()
  assert.deepEqual(used, ['R1', 'R2'])
  assert.equal(data?.ok, true)
  assert.deepEqual(r.cumulativeChanges.value, [])
  // 全部撤回 = 新的起点
  assert.equal(r.sessionBaselineRunId.value, '')
})

test('基准已被回收：清空锚点并给出可操作提示，不抛错', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'gone'
  diffReply = { error: '基准记录不存在' }

  await r.setChangeView('cumulative')

  assert.deepEqual(r.cumulativeChanges.value, [])
  assert.equal(r.sessionBaselineRunId.value, '')
  assert.match(r.cumulativeError.value, /已失效/)
})

test('网络异常：降级为空列表 + 可读原因，且不误清基准', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  fetchThrows = true

  await r.setChangeView('cumulative')

  assert.deepEqual(r.cumulativeChanges.value, [])
  assert.match(r.cumulativeError.value, /网络异常/)
  assert.equal(r.sessionBaselineRunId.value, 'R1')
})

test('确认改动：两套列表清空且锚点重置（语义上的新起点）', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  r.result.value = { runId: 'RCUR' } as never
  r.changes.value = [{ path: 'z.ts', type: 'modified' }]
  r.cumulativeChanges.value = [{ path: 'a.ts', type: 'modified', runId: 'R1' }]

  await r.save()

  assert.deepEqual(r.changes.value, [])
  assert.deepEqual(r.cumulativeChanges.value, [])
  assert.equal(r.sessionBaselineRunId.value, '')
})

test('累积返回同 path 重复条目时按 path 去重', async () => {
  const r = mod.useRunner()
  r.sessionBaselineRunId.value = 'R1'
  diffReply = {
    baselineRunId: 'R1',
    changes: [
      { path: 'a.ts', type: 'modified', runId: 'R1' },
      { path: 'a.ts', type: 'added', runId: 'R2' },
    ],
  }

  await r.setChangeView('cumulative')

  assert.equal(r.cumulativeChanges.value.length, 1)
  assert.equal(r.cumulativeChanges.value[0].type, 'added')
})
