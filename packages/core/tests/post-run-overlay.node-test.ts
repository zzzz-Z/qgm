// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-overlay.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-overlay.node-test.ts 迁至 test/post-run-overlay.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/overlay.node-test.ts 迁至 client/test/post-run-overlay.node-test.ts
import { afterEach, beforeEach, test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyOverlay, readOverlayChanges } from '../../../packages/core/src/post-run/overlay.js'

// [test-tmpdir-v1] 夹具不再落 .ai-runner（中断/超时会残留累积）。
// applyOverlay/readOverlayChanges 以 getRoot() 为基准过滤越界路径，故用 AI_RUNNER_ROOT
// 把 getRoot() 指向临时目录（getRoot 每次调用现读 env，见 overlay.ts:18）。
let ROOT = ''
beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'test-overlay-'))
  process.env.AI_RUNNER_ROOT = ROOT
})
afterEach(() => {
  delete process.env.AI_RUNNER_ROOT
  if (ROOT) fs.rmSync(ROOT, { recursive: true, force: true })
})

function tmpDir(): string {
  return fs.mkdtempSync(path.join(ROOT, 'inner-'))
}

function writeOverlay(dir: string, payload: unknown): string {
  const p = path.join(dir, 'overlay.json')
  fs.writeFileSync(p, JSON.stringify(payload))
  return p
}

test('applyOverlay: 不存在 → applied=0', () => {
  assert.deepEqual(applyOverlay('/tmp/no-such-overlay-xyz.json'), { applied: 0 })
})

test('applyOverlay: 坏 JSON → applied=0', () => {
  const d = tmpDir()
  try {
    const p = path.join(d, 'ov.json')
    fs.writeFileSync(p, '{not-json')
    assert.deepEqual(applyOverlay(p), { applied: 0 })
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('applyOverlay: write 操作写入 base64 解码后的文件', () => {
  const d = tmpDir()
  try {
    const target = path.join(d, 'sub', 'out.txt')
    const payload = { [target]: { op: 'write', data: Buffer.from('hello').toString('base64') } }
    const ovp = writeOverlay(d, payload)
    const r = applyOverlay(ovp)
    assert.equal(r.applied, 1)
    assert.equal(fs.readFileSync(target, 'utf8'), 'hello')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('applyOverlay: delete 操作移除文件', () => {
  const d = tmpDir()
  try {
    const target = path.join(d, 'goner.txt')
    fs.writeFileSync(target, 'x')
    const payload = { [target]: { op: 'delete', data: null } }
    const r = applyOverlay(writeOverlay(d, payload))
    assert.equal(r.applied, 1)
    assert.equal(fs.existsSync(target), false)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('applyOverlay: write data 为空跳过（不算 applied）', () => {
  const d = tmpDir()
  try {
    const target = path.join(d, 'skipped.txt')
    const payload = { [target]: { op: 'write', data: null } }
    const r = applyOverlay(writeOverlay(d, payload))
    assert.equal(r.applied, 0)
    assert.equal(fs.existsSync(target), false)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('applyOverlay: 未知 op 被忽略', () => {
  const d = tmpDir()
  try {
    const target = path.join(d, 'x.txt')
    const payload = { [target]: { op: 'unknown', data: 'aGk=' } }
    const r = applyOverlay(writeOverlay(d, payload))
    assert.equal(r.applied, 0)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('applyOverlay: 项目外路径被跳过', () => {
  const d = tmpDir()
  try {
    const payload = { '/etc/passwd': { op: 'write', data: 'aGk=' } }
    const r = applyOverlay(writeOverlay(d, payload))
    assert.equal(r.applied, 0)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('readOverlayChanges: 不存在 → []', () => {
  assert.deepEqual(readOverlayChanges('/tmp/no-such-ov.json', new Map()), [])
})

test('readOverlayChanges: write → added（before 无）', () => {
  const d = tmpDir()
  try {
    const target = path.join(ROOT, 'src', 'tmp-file-x.ts')
    const payload = { [target]: { op: 'write', data: 'aGk=' } }
    const ovp = writeOverlay(d, payload)
    const r = readOverlayChanges(ovp, new Map())
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'added')
    assert.equal(r[0].path, 'src/tmp-file-x.ts')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('readOverlayChanges: write → modified（before 有）', () => {
  const d = tmpDir()
  try {
    const target = path.join(ROOT, 'src', 'tmp-file-y.ts')
    const payload = { [target]: { op: 'write', data: 'aGk=' } }
    const ovp = writeOverlay(d, payload)
    const before = new Map([['src/tmp-file-y.ts', 'old']])
    const r = readOverlayChanges(ovp, before)
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'modified')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('readOverlayChanges: delete → deleted', () => {
  const d = tmpDir()
  try {
    const target = path.join(ROOT, 'src', 'tmp-file-z.ts')
    const payload = { [target]: { op: 'delete', data: null } }
    const r = readOverlayChanges(writeOverlay(d, payload), new Map())
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'deleted')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('readOverlayChanges: 项目外路径被忽略', () => {
  const d = tmpDir()
  try {
    const payload = { '/etc/hosts': { op: 'write', data: 'aGk=' } }
    const r = readOverlayChanges(writeOverlay(d, payload), new Map())
    assert.deepEqual(r, [])
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('readOverlayChanges: 坏 JSON → []', () => {
  const d = tmpDir()
  try {
    const p = path.join(d, 'ov.json')
    fs.writeFileSync(p, 'not json')
    assert.deepEqual(readOverlayChanges(p, new Map()), [])
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('applyOverlay: 白名单文件（.ai-runner/<tmp>/state.json）正常落盘', () => {
  const subdir = path.join(ROOT, 'keep')
  const target = path.join(subdir, 'state.json')
  try { fs.unlinkSync(target) } catch { /* 不存在 */ }
  const d = tmpDir()
  try {
    const payload = { [target]: { op: 'write', data: Buffer.from('{}').toString('base64') } }
    const r = applyOverlay(writeOverlay(d, payload))
    assert.equal(r.applied, 1)
    assert.equal(fs.existsSync(target), true)
  } finally { fs.rmSync(d, { recursive: true, force: true }); try { fs.rmSync(subdir, { recursive: true, force: true }) } catch { /* ignore */ } }
})

test('readOverlayChanges: 白名单文件正常出现在变更报告', () => {
  const subdir = path.join(ROOT, 'report')
  const target = path.join(subdir, 'changelog.jsonl')
  const d = tmpDir()
  try {
    const payload = { [target]: { op: 'write', data: 'aGk=' } }
    const r = readOverlayChanges(writeOverlay(d, payload), new Map())
    assert.equal(r.length, 1)
    assert.equal(r[0].type, 'added')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})
