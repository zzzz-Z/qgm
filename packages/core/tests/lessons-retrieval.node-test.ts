// [lessons-retrieval-v1] core 侧承重判据：检索命中相关性、状态行随条目保留、切分口径与共享模块一致。
// [WHY] lessons 注入从「尾截断 5.3%」改为「按任务检索 top-k」；这三条是最易写成真空判据的地方。
// [CONSTRAINT] 不依赖运行态；fixture 落 tmpRoot，经 setRoot 注入。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'vitest'
import { listLessonDocs, rankLessons } from '../src/lessons/retriever.js'
import { setRoot } from '../src/config.js'

// 共享解析器：测试侧 require（生产代码不跨包 require 仓库脚本）
// eslint-disable-next-line ts/no-require-imports
const sharedParse = require('../../../scripts/lessons-parse.cjs') as { parseLessons: (raw: string) => Array<{ title: string }> }

const N = String.fromCharCode(10)
let tmpRoot = ''

const FIXTURE = [
  '# Lessons',
  '',
  '## e2e 端口漂移真因',
  '[VERIFIED] 2026-10-06 A · 实测 .server-port 残留旧值',
  '正文：vite 代理据 .server-port 指向错误端口。',
  '',
  '## 已被推翻的归因',
  '[REJECTED] 2026-10-05 A · 实测推翻',
  '正文：错误归因描述。',
  '',
  '## 无关条目',
  '正文：与查询无关。',
  '',
].join(N)

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'air-lessons-retr-'))
  const dir = path.join(tmpRoot, '.ai-runner')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'lessons.md'), FIXTURE, 'utf8')
  setRoot(tmpRoot)
})

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// 判据①：给定 query，检索必须命中相关条目（变异：把检索退回尾截断 ⇒ 不命中 ⇒ 红）
test('判据① 相关查询命中对应条目', () => {
  const docs = listLessonDocs(tmpRoot)
  assert.ok(docs.length >= 3, 'fixture 应解析出 ≥3 条')
  const hits = rankLessons('e2e 端口漂移', docs, 3)
  assert.ok(hits.length >= 1, '相关查询必须命中至少一条')
  assert.ok(
    hits.some(h => h.title.includes('端口漂移')),
    `未命中「端口漂移」条目：${JSON.stringify(hits.map(h => h.title))}`,
  )
})

// 判据③：命中 [REJECTED] 条目时，状态行逐字在返回正文内（变异：拼装时剥掉首行 ⇒ 红）
test('判据③ 状态行随条目 verbatim 保留，不被剥离', () => {
  const docs = listLessonDocs(tmpRoot)
  const rejected = docs.find(d => d.title === '已被推翻的归因')
  assert.ok(rejected, 'fixture 应含 [REJECTED] 条目')
  assert.equal(rejected!.state, 'rejected', 'state 判定须识别 [REJECTED]')
  assert.ok(
    rejected!.body.startsWith('[REJECTED]'),
    `状态行未保留在 body 首行：${JSON.stringify(rejected!.body.slice(0, 40))}`,
  )

  // 检索命中该条时，body 仍带状态行
  const hits = rankLessons('推翻 归因', docs, 3)
  const hit = hits.find(h => h.title === '已被推翻的归因')
  assert.ok(hit, '应命中 REJECTED 条目')
  assert.ok(hit!.body.includes('[REJECTED]'), '命中的正文必须仍含状态行')
})

test('listLessonDocs：state 三态识别正确', () => {
  const docs = listLessonDocs(tmpRoot)
  assert.equal(docs.find(d => d.title === 'e2e 端口漂移真因')?.state, 'verified')
  assert.equal(docs.find(d => d.title === '已被推翻的归因')?.state, 'rejected')
  assert.equal(docs.find(d => d.title === '无关条目')?.state, 'pending')
})

// 判据⑤：切分口径一致（变异：服务端改用 ### 分条 ⇒ 序列不等 ⇒ 红）
test('判据⑤ 切分口径与共享模块一致：title 序列逐条相等', () => {
  const docs = listLessonDocs(tmpRoot)
  const shared = sharedParse.parseLessons(FIXTURE)
  // 防空转：两侧都退化为空数组时 deepEqual 恒真，判据就成了真空
  assert.ok(docs.length >= 3, `listLessonDocs 应解析出 ≥3 条，实得 ${docs.length}——切分口径已坏或 fixture 失效`)
  assert.deepEqual(
    docs.map(d => d.title),
    shared.map(s => s.title),
    'listLessonDocs 的 title 序列必须与 scripts/lessons-parse.cjs 完全一致',
  )
})

test('文件缺失：返回空数组，不抛错', () => {
  fs.rmSync(path.join(tmpRoot, '.ai-runner', 'lessons.md'))
  assert.deepEqual(listLessonDocs(tmpRoot), [])
})

test('空查询 / 零命中：返回空数组，不抛错', () => {
  const docs = listLessonDocs(tmpRoot)
  assert.deepEqual(rankLessons('', docs, 3), [])
  assert.deepEqual(rankLessons('qqqzzzxxx', docs, 3), [])
})
