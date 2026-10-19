// [pure-parity-v1] 油猴侧与 headless 侧同名纯函数的行为等价守卫。
// [NOT-TESTED] 以下函数因 harness 局限未纳入：
//   - hasUnclosedStructureJs / scanReplyMarks / scanObjectEnd：内部含 `{` `}` 字符字面量，
//     extractInner 的「数括号」启发式会抠错边界。
//   - safeJsonParse：内部调用同文件另一函数（escapeControlCharsInStrings），runInVm 只注入单函数。
//   它们的等价性由各自的独立行为测试保证。
// [WHY] 同一份逻辑在两处独立实现，一旦某侧单独修改另一侧会静默分叉。
// [CONSTRAINT] 只覆盖输入/输出为原始类型的函数。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { test } from 'vitest'
import assert from 'node:assert/strict'

const ROOT = join(import.meta.dirname, '../../..')
const HEADLESS = 'packages/core/src/headless/headless-inject.ts'
const TM = 'scripts/tampermonkey-session-id.user.js'

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

function extractInner(src: string, name: string): string | null {
  const lines = src.split('\n')
  const re = new RegExp(`^(?:export )?function ${name}\\b`)
  const start = lines.findIndex(l => re.test(l.trim()))
  if (start < 0) return null
  let depth = 0
  let end = start
  for (let i = start; i < lines.length; i++) {
    if (lines[i].includes('{')) depth++
    if (lines[i].includes('}')) depth--
    if (depth === 0 && i > start) { end = i; break }
  }
  return lines.slice(start, end + 1).join('\n')
}

function runInVm(body: string, args: unknown[]): unknown {
  const name = body.match(/function (\w+)/)?.[1] || 'fn'
  const src = `(function () { ${body} ; return ${name} })()`
  const fn = vm.runInNewContext(src, {}) as (...a: unknown[]) => unknown
  return fn(...args)
}

test('hash32: 同一输入两侧同 hash', () => {
  const inputs = ['', 'a', 'hello', '中文', 'x'.repeat(200)]
  const h = extractInner(read(HEADLESS), 'hash32')!
  const tm = extractInner(read(TM), 'hash32')!
  for (const inp of inputs) {
    assert.equal(runInVm(h, [inp]), runInVm(tm, [inp]), `hash32 分叉 input=${inp.slice(0, 20)}`)
  }
})

test('decideScriptFence: 同一输入两侧同布尔', () => {
  const inputs = [[true, 0, false], [true, 5, false], [false, 0, false], [true, 0, true], [false, 3, true]]
  const h = extractInner(read(HEADLESS), 'decideScriptFence')!
  const tm = extractInner(read(TM), 'decideScriptFence')!
  for (const args of inputs) {
    assert.equal(runInVm(h, args as unknown[]), runInVm(tm, args as unknown[]), `decideScriptFence 分叉 args=${JSON.stringify(args)}`)
  }
})

test('turnAwaiting: 同一输入两侧同结果', () => {
  const inputs = [[], [{ type: 'say' }], [{ type: 'script' }], [{ type: 'ask' }], [{ type: 'say' }, { type: 'script' }]]
  const h = extractInner(read(HEADLESS), 'turnAwaiting')!
  const tm = extractInner(read(TM), 'turnAwaiting')!
  for (const blocks of inputs) {
    assert.equal(runInVm(h, [blocks]), runInVm(tm, [blocks]), `turnAwaiting 分叉 blocks=${JSON.stringify(blocks)}`)
  }
})

test('escapeControlCharsInStrings: 同一输入两侧同结果', () => {
  const inputs = ['', 'plain', 'with \\n', '{"a":"b\nc"}', 'tab\there']
  const h = extractInner(read(HEADLESS), 'escapeControlCharsInStrings')!
  const tm = extractInner(read(TM), 'escapeControlCharsInStrings')!
  for (const inp of inputs) {
    assert.equal(runInVm(h, [inp]), runInVm(tm, [inp]), `escapeControlChars 分叉 input=${JSON.stringify(inp.slice(0, 30))}`)
  }
})

test('langFromText: 同一输入两侧同结果', () => {
  const inputs = ['', '#!/usr/bin/env node\ncode()', 'const x = 1', 'print(1)', 'function foo() {}']
  const h = extractInner(read(HEADLESS), 'langFromText')!
  const tm = extractInner(read(TM), 'langFromText')!
  for (const inp of inputs) {
    assert.equal(runInVm(h, [inp]), runInVm(tm, [inp]), `langFromText 分叉 input=${JSON.stringify(inp.slice(0, 30))}`)
  }
})
test('hasExecutableContent: 同一输入两侧同布尔', () => {
  const inputs = ['', '//only comments', '#!node\n//x', 'code()', 'a\nb\nc']
  const h = extractInner(read(HEADLESS), 'hasExecutableContent')!
  const tm = extractInner(read(TM), 'hasExecutableContent')!
  for (const inp of inputs) {
    assert.equal(runInVm(h, [inp]), runInVm(tm, [inp]), `hasExecutableContent 分叉 input=${JSON.stringify(inp.slice(0, 30))}`)
  }
})

// [pure-parity-v1] hasUnclosedStructureJs 未纳入：该函数内部就在处理 { } 配对，
//   用「数括号」的 extractInner 抠它天然不可靠（会抠错边界）。其等价性由各自的行为测试保证。

test('harness: 能抠出两侧 hash32 并执行', () => {
  const h = extractInner(read(HEADLESS), 'hash32')
  const t = extractInner(read(TM), 'hash32')
  assert.ok(h, 'headless 侧缺 hash32')
  assert.ok(t, '油猴侧缺 hash32')
  assert.equal(runInVm(h, ['a']), runInVm(t, ['a']), 'hash32 行为分叉')
})
