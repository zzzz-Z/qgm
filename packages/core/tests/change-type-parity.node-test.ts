// [change-type-parity-v1] `Change` / `ChangeType` 五处定义必须逐字一致。
//
// [WHY 为什么会有五份] 不是疏忽，是 strip-types 硬约束：`--experimental-strip-types` 不重写
//   `.js → .ts` 路径，post-run 三文件若 `import ... from '../config.js'` 会加载失败，只能内联。
//   （见 overlay.ts:5 / tsc-targets.ts:1 / lint-targets.ts:1 的 AIRUNNER-BATCH10 注释）
//
// [WHY 为什么需要守卫] `scriptMeta` 双份有 scriptMeta.node-test.ts 守；`Change` 五份此前**零守卫**，
//   任一处加字段/改枚举，其余四处不会报错——只在运行时字段缺失才暴露。
//   本守卫用静态文本解析（不 runtime import），与 inline-constants-parity 同范式。
//
// [判据承重] 任一处加字段 / 改 ChangeType 枚举 / 删字段 ⇒ 对应用例必红（变异已验证）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

/** 五处定义位置：[文件, 侧]。client 与 core 分属两包，无法共享类型，但语义必须一致。 */
const SITES: Array<[string, 'client' | 'core']> = [
  ['packages/client/types.ts', 'client'],
  ['packages/core/src/config.ts', 'core'],
  ['packages/core/src/post-run/lint-targets.ts', 'core'],
  ['packages/core/src/post-run/overlay.ts', 'core'],
  ['packages/core/src/post-run/tsc-targets.ts', 'core'],
]

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 从 `export interface Change { ... }` 提取字段名（去掉 `?` 与类型注解）。
 * [CONSTRAINT] 只处理单层扁平接口；Change 目前是扁平的，若将来加嵌套需扩展本函数。
 */
function extractChangeFields(src: string): string[] {
  const m = src.match(/export interface Change \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('未找到 export interface Change { ... }')
  return m[1]!
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
    .map(l => l.split(':')[0]!.replace(/\?$/, '').trim())
    .filter(Boolean)
}

/** 从 `export type ChangeType = 'a' | 'b'` 提取字面量集合（排序后比对） */
function extractChangeType(src: string): string[] {
  const m = src.match(/export type ChangeType =([^\n]+)/)
  if (!m) throw new Error('未找到 export type ChangeType')
  return (m[1]!.match(/'([^']+)'/g) || []).map(s => s.slice(1, -1)).sort()
}

test('Change 五处字段集逐字一致', () => {
  const all = SITES.map(([rel]) => ({ rel, fields: extractChangeFields(read(rel)) }))
  const base = all[0]!
  for (const { rel, fields } of all.slice(1)) {
    assert.deepEqual(
      fields,
      base.fields,
      `${rel} 的 Change 字段与 ${base.rel} 不一致：${fields.join(',')} vs ${base.fields.join(',')}`
      + '（strip-types 约束下无法共享类型，但语义必须一致；改一处必须全处同步）',
    )
  }
  assert.ok(base.fields.length >= 3, `Change 字段数异常少（${base.fields.length}）`)
})

test('ChangeType 五处枚举值逐字一致', () => {
  const all = SITES.map(([rel]) => ({ rel, types: extractChangeType(read(rel)) }))
  const base = all[0]!
  for (const { rel, types } of all.slice(1)) {
    assert.deepEqual(
      types,
      base.types,
      `${rel} 的 ChangeType 与 ${base.rel} 不一致：${types.join(',')} vs ${base.types.join(',')}`
    )
  }
  assert.deepEqual(base.types, ['added', 'deleted', 'modified'], 'ChangeType 枚举值变了（新增/删除类型需五处同步）')
})
