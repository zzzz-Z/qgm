// [round-changes-runid-v1] 本轮视图「服务端 manifest 兜底 → 变更预览」链路的守卫
// [WHY] 这条链断在中间且**完全静默**：/__ai/run-changes 返回的 manifest 条目只有 path/type，
//   而变更预览要按「该轮 runId」取运行前快照（/__ai/files/before）才能算出 +/− 行。
//   忘了把响应上的 runId 盖到条目上 ⇒ 刷新后由兜底恢复出的列表每条都缺 runId ⇒
//   预览只会显示一句「未找到变更前快照」，diff 恒空。界面看起来是功能没做，实际是**客户端丢字段**。
// [HOW] 判据刻意从 `setChangeView('round')` 起跑（集成层），不是直接 import 那个纯函数——
//   否则「调用点删掉 stamping」这种回归测不出来。
// 环境：node + storage/window 桩（与 useRunnerCumulative.node-test.ts 同构；vueuse 需要它们）
import { beforeAll, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import type { Ref } from 'vue'

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
Object.defineProperty(globalThis, 'Storage', { configurable: true, writable: true, value: class { } })
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
    dispatchEvent: (): boolean => true,
  },
})

/** 最小 ref 替身（只用 .value） */
function refStub<T>(v: T): Ref<T> {
  return { value: v } as unknown as Ref<T>
}

interface FetchCall { url: string, body: Record<string, unknown> }
let calls: FetchCall[] = []
/** /run-changes 的响应；默认「服务端没在条目上带 runId」（真实行为） */
let roundReply: unknown = { ok: true, runId: 'R9', changes: [{ path: 'a.vue', type: 'modified' }] }
/** before 快照：命中 key 才 exists:true */
let beforeStore: Record<string, string> = {}
/** 磁盘态内容 */
let afterStore: Record<string, string> = {}

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
  calls.push({ url, body })
  let payload: unknown = {}
  if (url.includes('/run-changes')) {
    payload = roundReply
  } else if (url.includes('/files/before')) {
    const key = `${String(body.runId)}|${String(body.file)}`
    payload = key in beforeStore ? { content: beforeStore[key], exists: true } : { content: '', exists: false }
  } else if (url.includes('/files/read')) {
    const p = String((body.paths as string[] | undefined)?.[0] ?? '')
    payload = { files: [{ path: p, content: afterStore[p] ?? '' }] }
  }
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

let mod: typeof import('../composables/runner/useRunner')
let pm: typeof import('../components/script/preview-manager')
beforeAll(async () => {
  mod = await import('../composables/runner/useRunner')
  pm = await import('../components/script/preview-manager')
})

beforeEach(() => {
  lsStore.clear()
  ssStore.clear()
  calls = []
  beforeStore = {}
  afterStore = {}
  roundReply = { ok: true, runId: 'R9', changes: [{ path: 'a.vue', type: 'modified' }] }
  const r = mod.useRunner()
  r.changeView.value = 'round'
  r.changes.value = []
  r.result.value = null
  r.sessionBaselineRunId.value = ''
  r.baselineRunId.value = ''
})

/** 命中 /files/before 的那次请求的 body */
function beforeCall(): Record<string, unknown> {
  const hit = calls.find(c => c.url.includes('/files/before'))
  assert.ok(hit, `没发 before 请求；实际 ${JSON.stringify(calls.map(c => c.url))}`)
  return hit.body
}

/** 用 useRunner 的可见变更驱动真 preview-manager（这条组合才是用户实际看到的链路） */
function drivePreview(r: ReturnType<typeof mod.useRunner>) {
  // [ref-stub-v1] 最小 ref 替身：Ref 的符号标记不参与运行期，这里按 preview-diff.node-test.ts
  //   的同构写法强转 —— 不要为此把 createPreviewManager 的入参放宽成普通对象（那会让真正的 Ref 漏校验）
  const before = refStub('')
  const after = refStub('')
  const missing = refStub(false)
  const file = refStub<string | null>(null)
  const type = refStub<'modified'>('modified')
  const loading = refStub(false)
  const mgr = pm.createPreviewManager({
    changes: r.visibleChanges,
    result: r.result,
    previewFile: file,
    previewType: type,
    previewBefore: before,
    previewAfter: after,
    previewBaselineMissing: missing,
    previewLoading: loading,
    rollback: async () => ({ ok: true }),
    rollbackAll: async () => ({ ok: true }),
  })
  return { mgr, state: { before, after, missing, loading } }
}

test('兜底条目缺 runId ⇒ 盖上响应 runId（否则预览拿不到该轮快照）', async () => {
  const r = mod.useRunner()
  await r.setChangeView('round')

  assert.deepEqual(r.changes.value.map(c => c.path), ['a.vue'])
  assert.equal(r.changes.value[0]?.runId, 'R9', 'manifest 条目没继承响应 runId ⇒ 预览算不出 diff')
})

test('端到端：兜底恢复的列表点开预览 ⇒ before/after 都取到，不是「未找到变更前快照」', async () => {
  const r = mod.useRunner()
  beforeStore['R9|a.vue'] = 'old line\n'
  afterStore['a.vue'] = 'new line\n'
  await r.setChangeView('round')

  const { mgr, state } = drivePreview(r)
  await mgr.onPreviewFile('a.vue')

  assert.equal(beforeCall().runId, 'R9', 'before 请求必须带**归属轮** runId')
  assert.equal(state.before.value, 'old line\n')
  assert.equal(state.after.value, 'new line\n')
  assert.equal(state.missing.value, false, '快照明明在，却降级成「未找到变更前快照」')
})

test('条目自带 runId 时不覆盖（累积口径的归属轮更精确）', async () => {
  const r = mod.useRunner()
  roundReply = { ok: true, runId: 'R9', changes: [{ path: 'a.vue', type: 'modified', runId: 'R1' }] }
  await r.setChangeView('round')

  assert.equal(r.changes.value[0]?.runId, 'R1')
  beforeStore['R1|a.vue'] = 'old\n'
  afterStore['a.vue'] = 'new\n'
  const { mgr } = drivePreview(r)
  await mgr.onPreviewFile('a.vue')
  assert.equal(beforeCall().runId, 'R1')
})

test('响应既无 entries runId 也无顶层 runId ⇒ 不猜，预览如实降级', async () => {
  const r = mod.useRunner()
  roundReply = { ok: true, changes: [{ path: 'a.vue', type: 'modified' }] }
  await r.setChangeView('round')

  assert.equal(r.changes.value[0]?.runId, undefined)
  afterStore['a.vue'] = 'only after\n'
  const { mgr, state } = drivePreview(r)
  await mgr.onPreviewFile('a.vue')

  // [git-first-rollback-v1] 无依据时不许发请求，也不许把 before 当空串（那会渲染成「整份新增」的假 diff）
  assert.equal(
    calls.filter(c => c.url.includes('/files/before')).length,
    0,
    '没有 runId 却仍去取快照 ⇒ 服务端只会返回「缺 runId」，白白一次往返',
  )
  assert.equal(state.missing.value, true)
  assert.equal(state.before.value, 'only after\n', '缺快照时必须按「全上下文」渲染')
})
