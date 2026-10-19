// [reflect-v1] 结构化反思承重守卫。
// @why 判据承重：每条在对应判定被删除或恒真时都会变红。
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
require(path.join(ROOT, 'packages/core/src/helpers.cjs'))
const AI = (globalThis as unknown as { __AI__: Record<string, unknown> }).__AI__
interface R { changed: string[], shouldTest: string[], untested: string[], risks: { kind: string, detail: string }[], nextStep: string }

const prev = process.env.AI_RUNNER_CHANGED
beforeEach(() => { delete process.env.AI_RUNNER_CHANGED })
afterEach(() => { if (prev === undefined) delete process.env.AI_RUNNER_CHANGED; else process.env.AI_RUNNER_CHANGED = prev })

test('R1 方法存在且 arity=1', () => {
  expect(typeof AI.reflect).toBe('function')
  expect((AI.reflect as (...a: unknown[]) => unknown).length).toBe(1)
})

test('R2 空变更集必须报 no-change 风险（防恒真放行）', () => {
  const r = (AI.reflect as (o?: object) => R)({})
  expect(r.changed).toEqual([])
  expect(r.risks.some(x => x.kind === 'no-change')).toBe(true)
})

test('R3 有变更未跑测试必须报 untested 并给出下一步', () => {
  process.env.AI_RUNNER_CHANGED = JSON.stringify(['packages/core/src/helpers/fs.cjs'])
  const r = (AI.reflect as (o?: object) => R)({})
  expect(r.untested.length).toBeGreaterThan(0)
  expect(r.risks.some(x => x.kind === 'untested')).toBe(true)
  expect(r.nextStep).toContain('先跑受影响测试')
})

test('R4 已跑全部受影响测试则无 untested 风险', () => {
  process.env.AI_RUNNER_CHANGED = JSON.stringify(['packages/core/src/helpers/fs.cjs'])
  const first = (AI.reflect as (o?: object) => R)({})
  const r = (AI.reflect as (o?: object) => R)({ testsRun: first.shouldTest })
  expect(r.untested).toEqual([])
  expect(r.risks.some(x => x.kind === 'untested')).toBe(false)
})

test('R5 看板失败项必须进 risks 且无未测项时优先级最高', () => {
  process.env.AI_RUNNER_CHANGED = JSON.stringify(['packages/core/src/helpers/fs.cjs'])
  const first = (AI.reflect as (o?: object) => R)({})
  const r = (AI.reflect as (o?: object) => R)({ testsRun: first.shouldTest, board: { failed: 2, running: 0 } })
  expect(r.untested).toEqual([])
  expect(r.risks.some(x => x.kind === 'board-failed')).toBe(true)
  expect(r.nextStep).toContain('看板失败项')
})
