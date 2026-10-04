// [lesson-route-v1] POST /lessons 的进程内回归：覆盖落盘、去重、空体
// WHY: 前端 SPA 无 fs 权限，采集经 HTTP 回传后端；此前唯一接线点在 headless 轮询，
//      前端会话绕过导致 DONE 踩坑记录漏采。本测试锁定路由行为，防回归。
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lessonsHono } from '../../../packages/core/src/routes/lessons.js'
import { setRoot } from '../../../packages/core/src/config.js'

const N = String.fromCharCode(10)
let tmpRoot = ''

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'air-lessons-route-'))
  setRoot(tmpRoot)
})

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function seedLessonsFile(): void {
  const dir = path.join(tmpRoot, '.ai-runner')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'lessons.md'), `# Lessons${N}`, 'utf8')
}

function readLessons(): string {
  return fs.readFileSync(path.join(tmpRoot, '.ai-runner', 'lessons.md'), 'utf8')
}

async function postLessons(body: unknown): Promise<{ status: number, json: { ok: boolean, added?: number, error?: string } }> {
  const res = await lessonsHono.request('/lessons', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() }
}

test('空 text 返回 ok:false 且不落盘', async () => {
  seedLessonsFile()
  const r = await postLessons({ text: '' })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.error, 'empty-text')
  assert.ok(!readLessons().includes('## '))
})

test('合法 DONE 文本落盘，added:1', async () => {
  seedLessonsFile()
  const text = ['DONE', '', '### 踩坑记录', '', '- **探针A**：落盘验证。'].join(N)
  const r = await postLessons({ text })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.equal(r.json.added, 1)
  assert.ok(readLessons().includes('## 探针A'))
})

test('同标题二次提交去重，added:0', async () => {
  seedLessonsFile()
  const text = ['DONE', '', '### 踩坑记录', '', '- **探针B**：去重验证。'].join(N)
  const r1 = await postLessons({ text })
  const r2 = await postLessons({ text })
  assert.equal(r1.json.added, 1)
  assert.equal(r2.json.added, 0)
  const hits = readLessons().split(N).filter(l => l === '## 探针B')
  assert.equal(hits.length, 1)
})

test('无踩坑记录段返回 added:0', async () => {
  seedLessonsFile()
  const r = await postLessons({ text: ['DONE', '', '### 结论', '完成。'].join(N) })
  assert.equal(r.json.ok, true)
  assert.equal(r.json.added, 0)
})
