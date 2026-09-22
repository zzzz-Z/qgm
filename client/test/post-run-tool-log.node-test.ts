// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/tool-log.node-test.ts 迁至 client/test/post-run-tool-log.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readToolLog, readToolLogWithRetry } from '../../src/post-run/tool-log.ts'

// AIRUNNER-BATCH10-6-TOOL-LOG
function tmpFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-tool-log-'))
  const p = path.join(dir, 'log.ndjson')
  fs.writeFileSync(p, content)
  return p
}

test('readToolLog: 文件不存在 → 空数组', () => {
  assert.deepEqual(readToolLog('/tmp/definitely-no-such-file-xyz.ndjson'), [])
})

test('readToolLog: 空文件 → 空数组', () => {
  const p = tmpFile('')
  try { assert.deepEqual(readToolLog(p), []) } finally { fs.rmSync(p, { force: true }) }
})

test('readToolLog: 单行 JSON 解析', () => {
  const p = tmpFile(JSON.stringify({ op: 'read', path: 'a.ts', size: 10 }) + String.fromCharCode(10))
  try {
    const r = readToolLog(p)
    assert.equal(r.length, 1)
    assert.equal(r[0].op, 'read')
    assert.equal(r[0].path, 'a.ts')
    assert.equal(r[0].size, 10)
  } finally { fs.rmSync(p, { force: true }) }
})

test('readToolLog: 多行 JSON 解析 + 空行被过滤', () => {
  const NL = String.fromCharCode(10)
  const body = [
    JSON.stringify({ op: 'a', path: 'x', size: 1 }),
    '',
    JSON.stringify({ op: 'b', path: 'y', size: 2 }),
  ].join(NL)
  const p = tmpFile(body)
  try {
    const r = readToolLog(p)
    assert.equal(r.length, 2)
    assert.deepEqual(r.map(x => x.op), ['a', 'b'])
  } finally { fs.rmSync(p, { force: true }) }
})

test('readToolLog: 坏 JSON 行被过滤', () => {
  const NL = String.fromCharCode(10)
  const body = [
    JSON.stringify({ op: 'ok', path: 'p', size: 1 }),
    'not-json',
    JSON.stringify({ op: 'ok2', path: 'q', size: 2 }),
  ].join(NL)
  const p = tmpFile(body)
  try {
    const r = readToolLog(p)
    assert.equal(r.length, 2)
    assert.deepEqual(r.map(x => x.op), ['ok', 'ok2'])
  } finally { fs.rmSync(p, { force: true }) }
})

test('readToolLogWithRetry: 存在即时返回', async () => {
  const p = tmpFile(JSON.stringify({ op: 'x', path: 'p', size: 1 }) + String.fromCharCode(10))
  try {
    const r = await readToolLogWithRetry(p, 500)
    assert.equal(r.length, 1)
  } finally { fs.rmSync(p, { force: true }) }
})

test('readToolLogWithRetry: 不存在时超时返回空数组', async () => {
  const t0 = Date.now()
  const r = await readToolLogWithRetry(`/tmp/nope-${Date.now()}.ndjson`, 200)
  const dt = Date.now() - t0
  assert.deepEqual(r, [])
  assert.ok(dt >= 150, `should wait at least ~150ms, got ${dt}`)
})

test('readToolLogWithRetry: 空文件同样视为无内容 → 等待超时', async () => {
  const p = tmpFile('')
  try {
    const t0 = Date.now()
    const r = await readToolLogWithRetry(p, 150)
    const dt = Date.now() - t0
    assert.deepEqual(r, [])
    assert.ok(dt >= 100, `got ${dt}`)
  } finally { fs.rmSync(p, { force: true }) }
})
