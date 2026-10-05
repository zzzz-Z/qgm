// [lessons-add-v1] 手工补记通道（bin/lessons-add.cjs → lessons-add-core.cjs）也须走近重复判定。
// [判据层选择 · 方案A] 用例断言的实现来自 dist 产物（core lib 动态 import 它），而源码是 .ts ——
//   改源码不重建产物会假绿、干净检出（无 dist）会直接红。故保留「走产物」的真实运行方式，
//   但在用例前加一道闸门：产物 mtime 必须 ≥ 对应源码 mtime，否则给出「请先跑 pnpm build」。
//   选 A 而非 B 的理由：A 顺带守住「运行态用的产物是新的」这一真实约束；B 只证明源码对，
//   不能防「产物陈旧」。合成用例（源新于产物）为这道闸门本身承重。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { addLesson } = require('../../../scripts/lessons-add-core.cjs') as {
  addLesson: (title: string, body: string, rootDir: string) => Promise<{ added: number, mode: string }>
}
const { checkPair, derivePairs, checkPairs } = require('../../../scripts/artifact-freshness.cjs') as {
  checkPair: (src: string, dist: string) => { ok: boolean, reason?: string }
  derivePairs: (entryDist: string, toSource: (d: string) => string) => Array<[string, string]>
  checkPairs: (pairs: Array<[string, string]>) => { ok: boolean, reason?: string, src?: string, dist?: string }
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..', '..', '..')
const NL = String.fromCharCode(10)

// [产物新鲜度闸门] core lib 走的是 dist；产物落后于源码时必须先 build，否则本文件全部假绿。
// [pair-from-dep-graph-v1] 闸门守的是 lesson-extract 的**依赖闭包**——它 import 的
//   lesson-title-similarity.js 同样承载被断言的行为（isNearDuplicateTitle/阈值），
//   硬编码一对会漏掉它。故从产物出发 BFS 相对 import 生成全部 pair。
const DIST_DIR = path.join(REPO, 'packages/core/dist/post-run')
const SRC_DIR = path.join(REPO, 'packages/core/src/post-run')
const toSource = (distAbs: string): string => path.join(SRC_DIR, `${path.basename(distAbs, '.js')}.ts`)
const FRESHNESS_PAIRS = derivePairs(path.join(DIST_DIR, 'lesson-extract.js'), toSource)
const FRESHNESS = checkPairs(FRESHNESS_PAIRS)

async function withTempRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-add-'))
  try {
    fs.mkdirSync(path.join(root, '.ai-runner'), { recursive: true })
    await fn(root)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('lessons-add: 产物不得落后于源码（否则用例测的是旧实现）', () => {
  assert.ok(
    FRESHNESS.ok,
    `产物不新鲜：${FRESHNESS.reason} —— 请先跑 pnpm build（本文件的判据依赖 dist 产物）`,
  )
})

test('lessons-add: 近重复标题应并入既有条目而非新增', async () => {
  assert.ok(FRESHNESS.ok, `前置闸门未过：${FRESHNESS.reason}`)
  await withTempRoot(async (root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, ['# Lessons', '', '## docs/plan 被 gitignore 但不在 eslint ignores 里', '', '原正文', ''].join(NL), 'utf8')
    await addLesson('docs/plan 被 gitignore 但 @antfu/eslint-config 会自动忽略', '补充正文。', root)
    const after = fs.readFileSync(file, 'utf8')
    const heads = after.split(NL).filter(l => l.startsWith('## '))
    assert.equal(heads.length, 1, `不得新增独立条目，实际：${heads.join(' | ')}`)
    assert.ok(after.includes('补充正文。'), '并入正文必须落盘')
  })
})

test('lessons-add: 全新标题正常追加', async () => {
  assert.ok(FRESHNESS.ok, `前置闸门未过：${FRESHNESS.reason}`)
  await withTempRoot(async (root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, ['# Lessons', '', '## 已有条目', '', '原正文', ''].join(NL), 'utf8')
    const r = await addLesson('一个完全不相干的新坑', '新正文。', root)
    assert.equal(r.added, 1)
    const after = fs.readFileSync(file, 'utf8')
    assert.ok(after.includes('## 一个完全不相干的新坑'))
    assert.ok(after.includes('新正文。'))
  })
})

// 合成用例：用两个临时文件构造「源新于产物」，为闸门本身承重。
// 变异 (i)：把 checkPair 的 distMtime < srcMtime 比较改成恒真（ok 恒 true）⇒ 本用例变红。
test('artifact-freshness: 源新于产物时判 stale，产物新于源时判 ok', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freshness-'))
  try {
    const src = path.join(dir, 'a.ts')
    const dist = path.join(dir, 'a.js')
    fs.writeFileSync(dist, 'old', 'utf8')
    fs.writeFileSync(src, 'new', 'utf8')
    // 让 src 的 mtime 明确晚于 dist（FS 时间粒度可能不足，手动前后错开 2s）
    const past = new Date(Date.now() - 5000)
    fs.utimesSync(dist, past, past)
    const stale = checkPair(src, dist)
    assert.equal(stale.ok, false, '源新于产物必须判 stale，否则闸门是空判据')
    assert.ok(String(stale.reason).includes('stale'), '失败原因须指明 stale')
    // 反向：把 dist 调到比 src 新
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(dist, future, future)
    assert.equal(checkPair(src, dist).ok, true, '产物新于源码必须判 ok')
    // 产物缺失：不得 skip，须判失败（与「不许 skip」的纪律一致）
    const missing = checkPair(src, path.join(dir, 'nope.js'))
    assert.equal(missing.ok, false, '产物缺失必须判失败，不得静默跳过')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// [pair-coverage-v1] 合成用例：造一个临时 dist 目录（a.js import ./b.js），
// 断言 derivePairs 覆盖依赖 b。变异（只返回首条）必须变红。
test('artifact-freshness: derivePairs 覆盖相对 import 依赖闭包', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-'))
  try {
    fs.writeFileSync(path.join(dir, 'a.ts'), '// src a', 'utf8')
    fs.writeFileSync(path.join(dir, 'b.ts'), '// src b', 'utf8')
    fs.writeFileSync(path.join(dir, 'b.js'), 'export const x = 1', 'utf8')
    fs.writeFileSync(path.join(dir, 'a.js'), 'import { x } from \'./b.js\'', 'utf8')
    const pairs = derivePairs(path.join(dir, 'a.js'), d => d.replace(/\.js$/, '.ts'))
    const bases = pairs.map(p2 => path.basename(p2[1]))
    assert.ok(bases.includes('a.js'), `pair 必含入口：${bases.join(',')}`)
    assert.ok(bases.includes('b.js'), `pair 必含直接依赖：${bases.join(',')}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// [dep-stale-gate-v1] 合成：依赖 b 的源码比产物新 ⇒ 闸门须红（对应「改依赖不重建」）。
test('artifact-freshness: 依赖产物陈旧时闸门变红', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depstale-'))
  try {
    const ajs = path.join(dir, 'a.js')
    const bjs = path.join(dir, 'b.js')
    const ats = path.join(dir, 'a.ts')
    const bts = path.join(dir, 'b.ts')
    fs.writeFileSync(bjs, 'export const x = 1', 'utf8')
    fs.writeFileSync(ajs, 'import { x } from "./b.js"', 'utf8')
    fs.writeFileSync(ats, '// src a', 'utf8')
    fs.writeFileSync(bts, '// src b', 'utf8')
    // b.ts 比 b.js 新（依赖陈旧），a 保持新鲜
    const past = new Date(Date.now() - 6000)
    const future = new Date(Date.now() + 1000)
    fs.utimesSync(ajs, past, past)
    fs.utimesSync(ats, past, past)
    fs.utimesSync(bjs, past, past)
    fs.utimesSync(bts, future, future)
    const pairs = derivePairs(ajs, d => d.replace(/\.js$/, '.ts'))
    const res = checkPairs(pairs)
    assert.equal(res.ok, false, '依赖陈旧必须判红，否则闸门漏依赖')
    assert.ok(String(res.dist || '').includes('b.js'), `失败项须是 b.js：${JSON.stringify(res)}`)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// [write-fail-v1] 写盘失败须与「全重复」区分。
test('lessons-add: 写盘失败抛 write-failed', async () => {
  await withTempRoot(async (root) => {
    const file = path.join(root, '.ai-runner', 'lessons.md')
    fs.writeFileSync(file, `# Lessons${NL}${NL}## x${NL}`, 'utf8')
    const orig = fs.writeFileSync
    fs.writeFileSync = () => { throw new Error('EACCES') }
    try {
      await assert.rejects(() => addLesson('zzz-new-title', 'b', root), /write-failed/)
    } finally {
      fs.writeFileSync = orig
    }
  })
})
