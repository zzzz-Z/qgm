// [helpers-io-v1] appendText / fileInfo 承重判据（WO-20261007-04 段三/四）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..', '..')
const IO = path.join(ROOT, 'packages', 'core', 'src', 'helpers', 'io.cjs')
const require_ = createRequire(import.meta.url)
const io = require_(IO)
test('appendText: 追加不覆盖，两次调用内容累积', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-'))
  const f = path.join(dir, 'a.txt')
  const r1 = io.appendText(f, 'AAA')
  const r2 = io.appendText(f, 'BBB')
  assert.equal(r1.bytes, 3); assert.equal(r2.bytes, 3)
  assert.equal(fs.readFileSync(f, 'utf8'), 'AAABBB')
})

test('appendText: 目标目录不存在时自动创建', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-'))
  const f = path.join(dir, 'deep', 'nested', 'a.txt')
  io.appendText(f, 'x')
  assert.equal(fs.readFileSync(f, 'utf8'), 'x')
})

test('fileInfo: 不存在 → exists=false / tracked=false', () => {
  const info = io.fileInfo(path.join(os.tmpdir(), 'no-such-file-xyz-123'))
  assert.equal(info.exists, false)
  assert.equal(info.tracked, false)
})

test('fileInfo: 已跟踪文件 tracked=true', () => {
  const info = io.fileInfo(path.join(ROOT, 'AGENTS.md'))
  assert.equal(info.exists, true)
  assert.equal(info.tracked, true)
  assert.ok(info.size > 0)
})

test('fileInfo: 临时未跟踪文件 tracked=false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-'))
  const f = path.join(dir, 'x.txt')
  fs.writeFileSync(f, 'hi')
  const info = io.fileInfo(f)
  assert.equal(info.exists, true)
  assert.equal(info.tracked, false)
})

// [helpers-io-v1] 集成点：经 __AI__ 面（非直 require helpers-io.cjs）调 appendText/fileInfo。
// [WHY] 只测 helpers-io.cjs 导出会绕过 helpers.cjs 的 __AI__ 转发；漏转发照样绿。
test('__AI__ 面：appendText/fileInfo 已转发且功能正确', () => {
  require_(path.join(ROOT, 'packages', 'core', 'src', 'helpers.cjs'))
  const AI = (globalThis as unknown as { __AI__: Record<string, (...a: unknown[]) => unknown> }).__AI__
  assert.equal(typeof AI.appendText, 'function', '__AI__.appendText 未转发')
  assert.equal(typeof AI.fileInfo, 'function', '__AI__.fileInfo 未转发')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-ai-'))
  const f = path.join(dir, 'a.txt')
  AI.appendText(f, 'AAA')
  AI.appendText(f, 'BBB')
  assert.equal(fs.readFileSync(f, 'utf8'), 'AAABBB')
  const info = AI.fileInfo(f) as Record<string, unknown>
  for (const k of ['exists', 'tracked', 'size', 'mtimeMs']) assert.ok(k in info, `fileInfo 缺字段 ${k}`)
})
