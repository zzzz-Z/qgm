// [symbol-semantic-v1] 符号语义层承重守卫：findDefinition / findReferences / renameSymbol。
// @why 判据必须承重（SYSTEM.md §14）：每条断言在对应实现被移除或退化成纯 grep 时都会变红。
//   ① 门面存在性 + arity —— 防「文档教了但门面没有」；
//   ② 定义点必须命中真实 file:line 且 kind 正确 —— 防「只返回随便一条匹配」；
//   ③ 引用必须区分 isDef —— 防「退化成 grep 的简单包装」；
//   ④ renameSymbol 不得落盘 —— 防「绕过 overlay 原子写直接改源码」。
import { expect, test } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const require = createRequire(import.meta.url)
require(path.join(ROOT, 'packages/core/src/helpers.cjs'))
const AI = (globalThis as unknown as { __AI__: Record<string, unknown> }).__AI__

test('S1 门面暴露三个符号语义方法且 arity 正确', () => {
  expect(typeof AI.findDefinition).toBe('function')
  expect(typeof AI.findReferences).toBe('function')
  expect(typeof AI.renameSymbol).toBe('function')
  expect((AI.findDefinition as (...a: unknown[]) => unknown).length).toBe(2)
  expect((AI.findReferences as (...a: unknown[]) => unknown).length).toBe(2)
  expect((AI.renameSymbol as (...a: unknown[]) => unknown).length).toBe(3)
})

test('S2 findDefinition 命中真实定义点且 kind 正确（非随便一条匹配）', () => {
  const defs = (AI.findDefinition as (n: string, o?: object) => { file: string, line: number, kind: string }[])(
    'createSearchApi',
    { dir: path.join(ROOT, 'packages/core/src/helpers'), limit: 10 },
  )
  expect(defs.length).toBeGreaterThan(0)
  const hit = defs.find(d => d.file.endsWith('search.cjs'))
  expect(hit, 'createSearchApi 的定义必须在 search.cjs 中被找到').toBeTruthy()
  expect(hit!.kind).toBe('function')
  const line = fs.readFileSync(hit!.file, 'utf8').split('\n')[hit!.line - 1]
  expect(line).toContain('function createSearchApi')
})

test('S3 findReferences 区分定义行与引用行（防退化成裸 grep）', () => {
  const refs = (AI.findReferences as (n: string, o?: object) => { file: string, line: number, isDef: boolean }[])(
    'createSearchApi',
    { dir: path.join(ROOT, 'packages/core/src/helpers'), limit: 100 },
  )
  expect(refs.length).toBeGreaterThan(0)
  const defs = refs.filter(r => r.isDef)
  const uses = refs.filter(r => !r.isDef)
  expect(defs.length, '必须至少有一条被标为定义').toBeGreaterThan(0)
  expect(uses.length, '必须至少有一条被标为引用（否则等于没区分）').toBeGreaterThan(0)
})

test('S4 renameSymbol 只产出计划，不改盘（overlay 原子写不可绕过）', () => {
  const target = path.join(ROOT, 'packages/core/src/helpers/search.cjs')
  const before = fs.statSync(target).mtimeMs
  const plan = (AI.renameSymbol as (a: string, b: string, o?: object) => { total: number })('createSearchApi', 'buildSearchApi', {
    dir: path.join(ROOT, 'packages/core/src/helpers'),
  })
  expect(plan.total).toBeGreaterThan(0)
  const after = fs.statSync(target).mtimeMs
  expect(after, 'renameSymbol 不得落盘').toBe(before)
})

test('S5 renameSymbol 拒绝非法标识符', () => {
  expect(() => (AI.renameSymbol as (a: string, b: string) => unknown)('createSearchApi', 'bad-name')).toThrow()
})
