// [inline-constants-parity-v1] config / snapshot / file-index 三处刻意内联的排除常量
// 必须保持一致；否则目录遍历与 diff 判定策略分叉（一处改了另两处未跟 → 隐藏 bug）。
// 用静态文本解析而非运行时 import，规避 strip-types 对 .js 后缀 import 的限制。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()

const SOURCES = [
  'packages/core/src/config.ts',
  'packages/core/src/state/snapshot.ts',
  'packages/core/src/utils/file-index.ts',
]

function extractLiteral(src: string, name: string): string[] {
  const marker = `const ${name} =`
  const i = src.indexOf(marker)
  if (i < 0) throw new Error(`missing literal: ${name}`)
  const start = src.indexOf('[', i)
  const end = src.indexOf(']', start)
  if (start < 0 || end < 0) throw new Error(`unterminated literal: ${name}`)
  const body = src.slice(start + 1, end)
  return body.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
}

function readAll(): string[] {
  const out: string[] = []
  for (const rel of SOURCES) {
    out.push(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
  }
  return out
}

test('inline constants parity: EXCLUDE_DIRS 三处一致', () => {
  const vals = readAll().map(src => extractLiteral(src, 'EXCLUDE_DIRS'))
  assert.deepEqual(vals[1], vals[0])
  assert.deepEqual(vals[2], vals[0])
})

test('inline constants parity: EXCLUDE_PREFIX 三处一致', () => {
  const vals = readAll().map(src => extractLiteral(src, 'EXCLUDE_PREFIX'))
  assert.deepEqual(vals[1], vals[0])
  assert.deepEqual(vals[2], vals[0])
})

test('inline constants parity: BINARY_EXT 三处一致', () => {
  const vals = readAll().map(src => extractLiteral(src, 'BINARY_EXT'))
  assert.deepEqual(vals[1], vals[0])
  assert.deepEqual(vals[2], vals[0])
})
