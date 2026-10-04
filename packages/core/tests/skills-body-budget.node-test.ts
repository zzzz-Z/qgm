// [body-budget-v1] 四档注入上限的回归护栏：BODY_MAX_LINES / LINE_MAX_CHARS / BODY_MAX_CHARS / TOTAL_MAX_CHARS
// WHY: 注入体积直接决定首问上下文开销；断言用字面量而非导入的常量，
// 否则「改常量 → 期望值同步变 → 永不红」，护栏形同虚设。
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skillsHono } from '../../../packages/core/src/routes/skills.js'
import { setRoot } from '../../../packages/core/src/config.js'

const N = String.fromCharCode(10)
let tmpRoot = ''

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'air-body-budget-'))
  setRoot(tmpRoot)
})

afterEach(() => {
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true })
})

function writeSkill(name: string, lineCount: number, lineChars: number): void {
  const dir = path.join(tmpRoot, '.ai-runner', 'skills', name)
  fs.mkdirSync(dir, { recursive: true })
  const body = Array.from({ length: lineCount }).fill('x'.repeat(lineChars)).join(N)
  const content = ['---', `name: ${name}`, 'description: probe', '---', body, ''].join(N)
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf8')
}

async function postMatch(query: string): Promise<{ matches: Array<{ name: string, body: string }> }> {
  const res = await skillsHono.request('/skills/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, limit: 10 }),
  })
  return await res.json() as { matches: Array<{ name: string, body: string }> }
}

test('三档上限各自生效：LINE_MAX_CHARS / BODY_MAX_CHARS / BODY_MAX_LINES', async () => {
  writeSkill('probe-tokenx', 1, 5000)
  writeSkill('probe-tokeny', 30, 100)
  writeSkill('probe-tokenz', 100, 10)
  const r = await postMatch('tokenx tokeny tokenz')
  assert.equal(r.matches.length, 3)
  const byLen: Record<string, number> = {}
  for (const m of r.matches) byLen[m.name] = m.body.length
  assert.equal(byLen['probe-tokenx'], 401, '单行 5000 字应被 LINE_MAX_CHARS=400 截断到 401')
  assert.equal(byLen['probe-tokeny'], 3001, '30 行 100 字应被 BODY_MAX_CHARS=3000 截断到 3001')
  assert.equal(byLen['probe-tokenz'], 659, '100 行 10 字应被 BODY_MAX_LINES=60 截断到 659')
})

test('TOTAL_MAX_CHARS 生效：三条大正文只回 1 条', async () => {
  writeSkill('probe-tokenx', 30, 100)
  writeSkill('probe-tokeny', 30, 100)
  writeSkill('probe-tokenz', 30, 100)
  const r = await postMatch('tokenx tokeny tokenz')
  assert.equal(r.matches.length, 1, '每条 3001 字符，两条即 6002 > TOTAL_MAX_CHARS=6000，第二条应触发 break')
})

test('TOTAL_MAX_CHARS 不误伤：三条小正文回 3 条', async () => {
  writeSkill('probe-tokenx', 5, 10)
  writeSkill('probe-tokeny', 5, 10)
  writeSkill('probe-tokenz', 5, 10)
  const r = await postMatch('tokenx tokeny tokenz')
  assert.equal(r.matches.length, 3)
})
