// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/useRunFeedback.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/useRunFeedback.node-test.ts 迁至 test/useRunFeedback.node-test.ts
// AIRUNNER-BATCH14-2-FIX-EMPTY-SET: 显式 Set<number> 避免 TS2345
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { isReadonlyResult, shouldIncludeChanges } from '../../packages/client/composables/runner/useRunFeedback.ts'
import type { Change, RunResponse } from '../../packages/client/types.ts'

// AIRUNNER-BATCH14-2-USE-RUN-FEEDBACK

function ch(path: string, type: Change['type'] = 'modified', afterLines?: number): Change {
  const c: Change = { path, type }
  if (afterLines !== undefined) c.afterLines = afterLines
  return c
}

function okResp(over: Partial<RunResponse> = {}): RunResponse {
  return {
    runId: 'r1',
    code: 0,
    ok: true,
    stdout: '',
    stderr: '',
    changes: [],
    ...over,
  } as RunResponse
}

// ============ shouldIncludeChanges ============
test('shouldIncludeChanges: 空 changes → true', () => {
  assert.equal(shouldIncludeChanges([], new Map()), true)
})

test('shouldIncludeChanges: 多条 changes → true', () => {
  assert.equal(shouldIncludeChanges([ch('a.ts'), ch('b.ts')], new Map()), true)
})

test('shouldIncludeChanges: 单条 + errorLocs 无该文件 → true', () => {
  assert.equal(shouldIncludeChanges([ch('a.ts')], new Map()), true)
})

test('shouldIncludeChanges: 单条 + errorLocs 命中且行号 <= afterLines+200 → false', () => {
  const locs = new Map([['a.ts', new Set([50])]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), false)
})

test('shouldIncludeChanges: 单条 + errorLocs 命中但行号 > afterLines+200 → true', () => {
  const locs = new Map([['a.ts', new Set([999])]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), true)
})

test('shouldIncludeChanges: 边界 afterLines+200 恰等 → false', () => {
  const locs = new Map([['a.ts', new Set([300])]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), false)
})

test('shouldIncludeChanges: 边界 afterLines+201 → true', () => {
  const locs = new Map([['a.ts', new Set([301])]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), true)
})

test('shouldIncludeChanges: afterLines 未定义视为 0（200 阈值）', () => {
  const locs = new Map([['a.ts', new Set([200])]])
  const c = ch('a.ts')
  assert.equal(shouldIncludeChanges([c], locs), false)
})

test('shouldIncludeChanges: locs 为空集 → 视为无错误 → true', () => {
  const locs = new Map([['a.ts', new Set<number>()]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), true)
})

test('shouldIncludeChanges: ./前缀 fallback 生效', () => {
  const locs = new Map([['./a.ts', new Set([50])]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), false)
})

test('shouldIncludeChanges: 前缀命中优先（带 ./ 的 key 优先于不带）', () => {
  const locs = new Map([['a.ts', new Set([999])], ['./a.ts', new Set([50])]])
  const c = ch('a.ts', 'modified', 100)
  // c.path 无 ./ → 命中 a.ts（999 > 300）→ true
  assert.equal(shouldIncludeChanges([c], locs), true)
})

test('shouldIncludeChanges: 多个错误行，任一 <= 阈值则 false', () => {
  const locs = new Map([['a.ts', new Set([999, 50])]])
  const c = ch('a.ts', 'modified', 100)
  assert.equal(shouldIncludeChanges([c], locs), false)
})

// ============ isReadonlyResult ============
test('isReadonlyResult: null → false', () => {
  assert.equal(isReadonlyResult(null, false), false)
})

test('isReadonlyResult: ok=false → false', () => {
  assert.equal(isReadonlyResult(okResp({ ok: false }), false), false)
})

test('isReadonlyResult: runId 空串 → false', () => {
  assert.equal(isReadonlyResult(okResp({ runId: '' }), false), false)
})

test('isReadonlyResult: 有 changes → false', () => {
  assert.equal(isReadonlyResult(okResp({ changes: [ch('a.ts')] }), false), false)
})

test('isReadonlyResult: isLoopActive=true → false', () => {
  assert.equal(isReadonlyResult(okResp(), true), false)
})

test('isReadonlyResult: ok/runId/无 changes/非循环 → true', () => {
  assert.equal(isReadonlyResult(okResp(), false), true)
})

test('isReadonlyResult: changes 为 undefined → 视为空 → true', () => {
  const r = okResp()
  delete (r as { changes?: Change[] }).changes
  assert.equal(isReadonlyResult(r as RunResponse, false), true)
})
