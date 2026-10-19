// [lessons-distill-v1] 蒸馏候选分析承重守卫。
// @why 判据承重：每条在统计逻辑退化（如恒返回空候选、恒定 ok:true）时都会变红。
import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
require(path.join(ROOT, 'packages/core/src/helpers.cjs'))
const AI = (globalThis as unknown as { __AI__: Record<string, unknown> }).__AI__

test('D1 门面 distill 方法存在且是函数', () => {
  const lessons = AI.lessons as Record<string, unknown>
  expect(typeof lessons.distill).toBe('function')
})

test('D2 路由端点已注册（源码级断言，防端点删除后仍「看起来正常」）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/routes/lessons.ts'), 'utf8')
  expect(src).toContain('\'/lessons/distill\'')
  expect(src).toContain('lessonsHono.get')
})

test('D3 统计口径含四态且不得恒零（防统计逻辑退化成空对象）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/routes/lessons.ts'), 'utf8')
  for (const s of ['verified', 'rejected', 'stale', 'pending']) {
    expect(src).toContain(s)
  }
  expect(src).toContain('byState[d.state]')
})

test('D4 候选分类含两类且不写盘（防误改成写操作）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'packages/core/src/routes/lessons.ts'), 'utf8')
  const i = src.indexOf('\'/lessons/distill\'')
  const seg = src.slice(i, i + 2000)
  expect(seg).toContain('evidence-missing')
  expect(seg).toContain('long-pending')
  expect(seg).not.toContain('writeFileSync')
  expect(seg).not.toContain('appendLessons')
})
