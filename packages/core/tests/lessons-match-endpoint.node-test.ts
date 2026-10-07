// [lessons-match-endpoint-v1] /lessons/match 端点评据：handler 契约 + barrel 接线。
// [WHY] WO-20261007-09 段C 明文规定「①③⑤ → core 侧（hono.request 直调 + node:http stub，同 WO-08）」，
//       而交付的 lessons-retrieval.node-test.ts 全部直调纯函数 ⇒ handler 的 limit 夹取、非 JSON 兜底、
//       异常兜底与 barrel 接线零覆盖（摘掉路由注册/摘掉 HONO_PREFIXES，那套测试仍全绿）。
//       本文件补这一层，范式对齐 wiki-proxy.node-test.ts。
// [CONSTRAINT] 不依赖运行态：fixture 落 tmpRoot，经 setRoot 注入。
//              承重（各配一组变异，改后必红）：摘路由注册 / 去 limit 夹取 / 写死 state / 摘 HONO_PREFIXES /
//              root 提到模块顶层缓存。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { setRoot } from '../src/config.js'
import { HONO_PREFIXES, HONO_SUB_APPS } from '../src/routes/index.js'
import { lessonsHono } from '../src/routes/lessons.js'

const N = String.fromCharCode(10)
let tmpRoot = ''
const extraRoots: string[] = []

// fixture：12 条。查询「alpha beta」共命中 9 条 —— 刻意多于默认 limit 3，否则「limit 夹取」的变异不可分辨。
// 词频按 BM25 的 df 截断反推：alpha 命中 6 条（6/12=0.5 ≤ DF_RATIO_MAX 0.6）、beta 命中 3 条（0.25）。
function buildFixture(): string {
  const rows: string[] = ['# Lessons', '']
  for (let i = 1; i <= 6; i += 1) {
    rows.push(`## alpha topic ${i}`, `[VERIFIED] 2026-10-06 A · 实测条目 ${i}`, `正文 ${i}`, '')
  }
  rows.push('## beta topic 7 已推翻', '[REJECTED] 2026-10-05 A · 实测推翻', '正文 7', '')
  for (let i = 8; i <= 9; i += 1) {
    rows.push(`## beta topic ${i}`, `[VERIFIED] 2026-10-06 A · 实测条目 ${i}`, `正文 ${i}`, '')
  }
  for (let i = 10; i <= 12; i += 1) {
    rows.push(`## gamma topic ${i}`, `[VERIFIED] 2026-10-06 A · 实测条目 ${i}`, `正文 ${i}`, '')
  }
  return rows.join(N)
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'air-lessons-match-'))
  const dir = path.join(tmpRoot, '.ai-runner')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'lessons.md'), buildFixture(), 'utf8')
  extraRoots.length = 0
  setRoot(tmpRoot)
})

afterEach(() => {
  for (const d of [tmpRoot, ...extraRoots]) {
    if (d) fs.rmSync(d, { recursive: true, force: true })
  }
})

interface MatchResp {
  ok: boolean
  query: string
  matches: Array<{ title: string, body: string, state: string, score: number, matched: string[] }>
}

async function postMatch(body: unknown): Promise<{ status: number, json: MatchResp }> {
  const res = await lessonsHono.request('/lessons/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as MatchResp }
}

// 变异：注释掉 lessons.ts 的 lessonsHono.post('/lessons/match', ...) ⇒ 404 ⇒ 本组全红
test('端点评据①：命中相关条目，且状态行/matched 经端点原样透出', async () => {
  const r = await postMatch({ query: 'alpha', limit: 3 })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.ok(r.json.matches.length >= 1, '相关查询必须命中至少一条')
  assert.ok(
    r.json.matches[0].title.startsWith('alpha topic'),
    `首选应为标题命中条：${JSON.stringify(r.json.matches.map(m => m.title))}`,
  )
  assert.ok(r.json.matches[0].body.startsWith('[VERIFIED]'), '状态行必须经端点原样透出（不得被 handler 剥掉）')
  assert.ok(Array.isArray(r.json.matches[0].matched), 'matched 字段须在响应内（与 /skills/match 对称）')
})

// 变异：把 handler 的 state 写死为 'verified' ⇒ 本判据红
test('端点评据③：[REJECTED] 条目 state=rejected，且正文含状态行', async () => {
  const r = await postMatch({ query: 'beta 推翻', limit: 5 })
  const hit = r.json.matches.find(m => m.title.includes('已推翻'))
  assert.ok(hit, `未命中 REJECTED 条目：${JSON.stringify(r.json.matches.map(m => m.title))}`)
  assert.equal(hit!.state, 'rejected')
  assert.ok(hit!.body.includes('[REJECTED]'), '命中的正文必须仍含状态行')
})

// 变异：把 limit 夹取改成无条件的 limit = Math.floor(n) ⇒ limit=999 返回 9 条 ⇒ 红
test('端点评据：limit 越界被夹取（999 ⇒ 落回默认 3；0 ⇒ 默认 3；10 ⇒ 上限内生效）', async () => {
  const big = await postMatch({ query: 'alpha beta', limit: 999 })
  assert.equal(big.json.matches.length, 3, 'limit=999 必须落回默认 3（透传会返回 9）')
  const zero = await postMatch({ query: 'alpha beta', limit: 0 })
  assert.equal(zero.json.matches.length, 3, 'limit=0 非法 ⇒ 落回默认 3')
  const ten = await postMatch({ query: 'alpha beta', limit: 10 })
  assert.equal(ten.json.matches.length, 9, 'limit=10 在上限内，应返回全部 9 条命中')
})

// 变异：删掉 c.req.json() 的 .catch ⇒ 非 JSON 抛错 ⇒ 500 ⇒ 红
test('端点评据：非 JSON body 不 500，返回空 matches', async () => {
  const r = await postMatch('not-json{')
  assert.equal(r.status, 200, '非 JSON body 不得 500')
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.matches, [])
})

test('端点评据：空 query ⇒ 空 matches（不抛错）', async () => {
  const r = await postMatch({ query: '' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.matches, [])
})

test('端点评据：lessons.md 缺失 ⇒ 空 matches（首问不得因它中断）', async () => {
  fs.rmSync(path.join(tmpRoot, '.ai-runner', 'lessons.md'))
  const r = await postMatch({ query: 'alpha' })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.matches, [])
})

// 变异：从 HONO_PREFIXES 摘掉 '/lessons' ⇒ 红（dispatchHono 不再 bridge，端点在生产路径上不可达）
test('接线：lessonsHono 挂进 HONO_SUB_APPS 与 HONO_PREFIXES', () => {
  assert.ok(HONO_SUB_APPS.includes(lessonsHono), 'lessonsHono 未挂 barrel')
  assert.ok(HONO_PREFIXES.includes('/lessons'), '/lessons 未进 HONO_PREFIXES')
})

// [request-time-root-v1] 同 WO-08 判据④的配套约束：env / 配置必须**请求期读取**。
// WHY: 若 root 在模块顶层缓存（const CACHED = getRoot()），handler 永远读首个 root ⇒
//      setRoot 注入失效 ⇒ 上面所有 fixture 判据一起变真空（全绿但测的是空目录）。
// 变异：在 lessons.ts 顶层加 const CACHED_ROOT_MUT = getRoot() 并改 handler 用它 ⇒ 本判据红。
test('端点评据④：root 请求期读取（换 root 后第二次请求须打到新 root）', async () => {
  const r1 = await postMatch({ query: 'alpha' })
  assert.ok(r1.json.matches.length >= 1, 'root A 应命中 alpha 条目')

  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'air-lessons-match-b-'))
  extraRoots.push(rootB)
  fs.mkdirSync(path.join(rootB, '.ai-runner'), { recursive: true })
  // 注意：新 root 必须 ≥2 条 —— 只有 1 条时查询词 df 比值 = 1.0 > DF_RATIO_MAX(0.6) 会被丢弃，
  // 命中恒为空 ⇒ 判据变真空（这正是「先跑干净基线」能抓到、只跑变异抓不到的坑）。
  fs.writeFileSync(
    path.join(rootB, '.ai-runner', 'lessons.md'),
    [
      '# Lessons',
      '',
      '## delta 仅存在于 root B',
      '[VERIFIED] 2026-10-06 A · 实测',
      '',
      '## epsilon 陪衬条',
      '[VERIFIED] 2026-10-06 A · 实测',
      '',
      '## zeta 陪衬条',
      '[VERIFIED] 2026-10-06 A · 实测',
      '',
    ].join(N),
    'utf8',
  )
  setRoot(rootB)

  const r2 = await postMatch({ query: 'delta' })
  assert.ok(r2.json.matches.length >= 1, '换 root 后应命中新 root 的 delta 条目')
  assert.ok(
    r2.json.matches[0].title.includes('delta'),
    `第二次请求打到了旧 root：${JSON.stringify(r2.json.matches.map(m => m.title))}`,
  )
  const r3 = await postMatch({ query: 'alpha' })
  assert.deepEqual(r3.json.matches, [], 'root B 下不得再命中 root A 的 alpha 条目（否则是顶层缓存了 root）')
})
