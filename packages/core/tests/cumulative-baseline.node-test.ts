// [cumulative-baseline-v1] /diff-from-baseline 的 mode / withOwner 契约守卫
// WHY: 累积视图的回滚正确性完全依赖「归属轮」判据——取错（最新而非最早）会让
//      「撤销该文件自基准以来的全部改动」静默退化成「只撤最后一轮」，
//      而这在 UI 上完全看不出来。故把判据锁成测试。
import { afterAll, beforeAll, expect, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 临时项目根；scanIndex / runDir 都按 AI_RUNNER_ROOT 解析 */
let root = ''
/** files 路由（Hono app；用 .request() 直接打端点） */
let filesHono: typeof import('../src/routes/files.js')['filesHono']
let prevRoot: string | undefined

/** 在临时根下写一个文件并回读其 stat（用于伪造索引条目） */
function writeFile(rel: string, content: string): fs.Stats {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
  return fs.statSync(abs)
}

/** 写一份索引 JSON */
function writeIndex(runId: string, file: string, obj: Record<string, { inode: number, mtimeMs: number, size: number }>): void {
  const dir = path.join(root, '.ai-runner/runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, file), JSON.stringify(obj))
}

/** 写一份 run manifest */
function writeManifest(runId: string, createdAt: number, changes: Array<{ path: string, type: string }>): void {
  const dir = path.join(root, '.ai-runner/runs', runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '_manifest.json'), JSON.stringify({ changes, createdAt }))
}

/** 打 /diff-from-baseline */
async function diffFromBaseline(body: Record<string, unknown>): Promise<{ status: number, json: Record<string, unknown> }> {
  const res = await filesHono.request('/diff-from-baseline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

/** 取变更列表（强类型视图，避免测试里散布 as 断言） */
function changesOf(json: Record<string, unknown>): Array<{ path: string, type: string, runId?: string, rollbackable?: boolean }> {
  return (json.changes || []) as Array<{ path: string, type: string, runId?: string, rollbackable?: boolean }>
}

beforeAll(async () => {
  prevRoot = process.env.AI_RUNNER_ROOT
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'airunner-cum-'))
  process.env.AI_RUNNER_ROOT = root

  const mod = await import('../src/routes/files.js')
  filesHono = mod.filesHono

  // 当前磁盘状态：三个文件都存在（基准索引里只登记 a.ts，故 b/c 会被判 added）
  const statA = writeFile('a.ts', 'export const a = 2')
  writeFile('b.ts', 'export const b = 1')
  writeFile('c.ts', 'export const c = 1')

  // R1：创建时刻最早，改过 a.ts
  writeManifest('R1', 1000, [{ path: 'a.ts', type: 'modified' }])
  // R1 的「运行前」索引：a.ts 尺寸与现在不同 → 累积口径下 a.ts 应被判 modified
  writeIndex('R1', '_index.before.json', { 'a.ts': { inode: 1, mtimeMs: 1, size: 1 } })
  // R1 的「运行后」索引：a.ts 已等于当前状态 → after 口径下 a.ts 应「无变化」
  writeIndex('R1', '_index.json', { 'a.ts': { inode: statA.ino, mtimeMs: statA.mtimeMs, size: statA.size } })
  fs.writeFileSync(path.join(root, '.ai-runner/runs/R1/a.ts.before'), 'export const a = 1')

  // R2：也改过 a.ts（用于验证归属取「最早」而非「最新」），并新增 b.ts、改 c.ts
  writeManifest('R2', 2000, [
    { path: 'a.ts', type: 'modified' },
    { path: 'b.ts', type: 'added' },
    { path: 'c.ts', type: 'modified' },
  ])
  writeIndex('R2', '_index.before.json', {})
  writeIndex('R2', '_index.json', {})

  // 无 gitRef 且无 .before 副本 → c.ts 的归属轮无法回滚
  fs.rmSync(path.join(root, '.ai-runner/runs/R2/c.ts.before'), { force: true })
})

afterAll(() => {
  if (prevRoot === undefined) delete process.env.AI_RUNNER_ROOT
  else process.env.AI_RUNNER_ROOT = prevRoot
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

test('缺 baselineRunId → 400', async () => {
  const r = await diffFromBaseline({})
  assert.equal(r.status, 400)
  expect(String(r.json.error)).toMatch(/baselineRunId/)
})

test('未知 baselineRunId → 404', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'nope-run' })
  assert.equal(r.status, 404)
  expect(String(r.json.error)).toMatch(/基准记录不存在/)
})

test('mode=before 但缺运行前索引 → 404 且提示可操作', async () => {
  writeManifest('R9', 3000, [])
  writeIndex('R9', '_index.json', {})
  const r = await diffFromBaseline({ baselineRunId: 'R9', mode: 'before' })
  assert.equal(r.status, 404)
  expect(String(r.json.error)).toMatch(/运行前索引/)
})

// ============ 回归：默认 mode=after 必须保持既有语义 ============

test('默认 mode=after：读运行后索引，基准轮自身的改动不算进来', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'R1' })
  assert.equal(r.status, 200)
  const list = changesOf(r.json)
  const paths = list.map(c => c.path)
  assert.ok(!paths.includes('a.ts'), 'after 口径下 a.ts 在 R1 结束时已等于现状，不应出现')
  assert.deepEqual(paths.sort(), ['b.ts', 'c.ts'])
})

test('不带 withOwner：条目里不得出现 runId 字段（既有调用方契约）', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'R1', mode: 'before' })
  assert.equal(r.status, 200)
  for (const c of changesOf(r.json)) {
    assert.ok(!('runId' in c), `未请求 withOwner 时不应带 runId：${c.path}`)
    assert.ok(!('rollbackable' in c), `未请求 withOwner 时不应带 rollbackable：${c.path}`)
  }
})

// ============ 累积口径 + 归属 ============

test('mode=before：基准轮开始前的状态参与比对（含基准轮自己的改动）', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'R1', mode: 'before' })
  assert.equal(r.status, 200)
  assert.deepEqual(changesOf(r.json).map(c => c.path).sort(), ['a.ts', 'b.ts', 'c.ts'])
})

test('归属轮取窗口内**最早**触碰者（不是最新）', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'R1', mode: 'before', withOwner: true })
  const map = new Map(changesOf(r.json).map(c => [c.path, c]))
  // a.ts 被 R1 与 R2 都改过 → 归属必须是 R1：否则「撤回」只撤掉最后一轮，
  // 用户以为撤销了全部累计改动，实际还留着 R1 的改动
  assert.equal(map.get('a.ts')?.runId, 'R1')
  assert.equal(map.get('b.ts')?.runId, 'R2')
  assert.equal(map.get('c.ts')?.runId, 'R2')
  assert.equal(r.json.baselineRunId, 'R1')
})

test('rollbackable 与 /rollback 的内容来源判定同构', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'R1', mode: 'before', withOwner: true })
  const map = new Map(changesOf(r.json).map(c => [c.path, c]))
  // R1 有 a.ts.before → 可回滚
  assert.equal(map.get('a.ts')?.rollbackable, true)
  // added 类型只需删除文件，不需要历史内容 → 可回滚
  assert.equal(map.get('b.ts')?.rollbackable, true)
  // R2 既无 gitRef 也无 c.ts.before → 必须显式 false（前端据此禁用按钮）
  assert.equal(map.get('c.ts')?.rollbackable, false)
})

test('mode=after + withOwner：窗口不含基准轮本身', async () => {
  const r = await diffFromBaseline({ baselineRunId: 'R1', mode: 'after', withOwner: true })
  const map = new Map(changesOf(r.json).map(c => [c.path, c]))
  // R1 在窗口外 → 只剩 R2 触碰的记录
  assert.ok(!map.has('a.ts'))
  assert.equal(map.get('b.ts')?.runId, 'R2')
})
