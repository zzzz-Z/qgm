// [selfcheck-shell-collect-v1] S3 守卫：bin/selfcheck.cjs 汇总 toolLog 的 exec 记录
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, beforeEach, it } from 'vitest'

const require = createRequire(import.meta.url)
const { collectObservedCommands } = require('../../../bin/selfcheck.cjs') as {
  collectObservedCommands: (runIds: string[]) => string[]
}

const CWD0 = process.cwd()
let tmpRoot = ''
let tmpDir = ''

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-collect-'))
  tmpDir = path.join(tmpRoot, '.ai-runner', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  process.chdir(tmpRoot)
})

afterAll(() => {
  process.chdir(CWD0)
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* ignore */ }
})

beforeEach(() => {
  // 清空 tmpDir 每次测试重置
  for (const n of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, n))
})

function writeLog(runId: string, lines: string[]): void {
  fs.writeFileSync(path.join(tmpDir, `${runId}-tools.jsonl`), lines.join('\n'), 'utf8')
}

it('S3: 空 runIds → 返回 []', () => {
  assert.deepEqual(collectObservedCommands([]), [])
})

it('S3: runIds 文件不存在 → 跳过不抛', () => {
  assert.deepEqual(collectObservedCommands(['nonexistent-id']), [])
})

it('S3: 提取 exec 记录的 flat 字段（含多条）', () => {
  writeLog('r1', [
    JSON.stringify({ ts: 1, op: 'exec', cmd: 'pnpm', flat: 'pnpm test:unit' }),
    JSON.stringify({ ts: 2, op: 'exec', cmd: 'node', flat: 'node -e 0' }),
  ])
  assert.deepEqual(collectObservedCommands(['r1']), ['pnpm test:unit', 'node -e 0'])
})

it('S3: 非 exec 记录（write/delete）被忽略', () => {
  writeLog('r2', [
    JSON.stringify({ ts: 1, op: 'write', path: 'a.ts', size: 1 }),
    JSON.stringify({ ts: 2, op: 'exec', cmd: 'pnpm', flat: 'pnpm tsc' }),
    JSON.stringify({ ts: 3, op: 'delete', path: 'b.ts', size: 0 }),
  ])
  assert.deepEqual(collectObservedCommands(['r2']), ['pnpm tsc'])
})

it('S3: 坏 JSON 行被静默忽略', () => {
  writeLog('r3', [
    '{not json',
    JSON.stringify({ ts: 1, op: 'exec', cmd: 'pnpm', flat: 'pnpm vitest' }),
  ])
  assert.deepEqual(collectObservedCommands(['r3']), ['pnpm vitest'])
})

it('S3: 多条 runIds → 合并所有命令', () => {
  writeLog('r4', [JSON.stringify({ ts: 1, op: 'exec', flat: 'pnpm a' })])
  writeLog('r5', [JSON.stringify({ ts: 2, op: 'exec', flat: 'pnpm b' })])
  assert.deepEqual(collectObservedCommands(['r4', 'r5']), ['pnpm a', 'pnpm b'])
})

it('S3: flat 空串或缺失 → 跳过该条', () => {
  writeLog('r6', [
    JSON.stringify({ ts: 1, op: 'exec', cmd: 'x' }),
    JSON.stringify({ ts: 2, op: 'exec', cmd: 'y', flat: '' }),
    JSON.stringify({ ts: 3, op: 'exec', cmd: 'z', flat: 'z run' }),
  ])
  assert.deepEqual(collectObservedCommands(['r6']), ['z run'])
})
