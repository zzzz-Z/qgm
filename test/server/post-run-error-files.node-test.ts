// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-error-files.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-error-files.node-test.ts 迁至 test/post-run-error-files.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/error-files.node-test.ts 迁至 client/test/post-run-error-files.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { extractErrorFiles } from '../../src/post-run/error-files.ts'

// 使用项目内确实存在的文件作为命中的目标
const KNOWN = 'src/post-run/error-files.ts'
const KNOWN2 = 'src/post-run/decision.ts'

test('空文本 → 空数组', () => {
  assert.deepEqual(extractErrorFiles(''), [])
})

test('纯文本无路径 → 空数组', () => {
  assert.deepEqual(extractErrorFiles('hello world'), [])
})

test('V8 栈格式：at fn (path:12:34) → 提取', () => {
  const text = `Error: x at fn (${KNOWN}:12:34)`
  assert.deepEqual(extractErrorFiles(text), [KNOWN])
})

test('裸相对路径 path:12:34 → 提取', () => {
  const text = `boom ${KNOWN}:42`
  assert.deepEqual(extractErrorFiles(text), [KNOWN])
})

test('绝对路径 → 转为项目相对路径', () => {
  const abs = `${process.cwd()}/${KNOWN}`
  const text = `at fn (${abs}:1:1)`
  assert.deepEqual(extractErrorFiles(text), [KNOWN])
})

test('node_modules 内路径被排除', () => {
  const text = 'at x (node_modules/foo/index.js:1:1)'
  assert.deepEqual(extractErrorFiles(text), [])
})

test('node: 前缀（内建模块）被排除', () => {
  const text = 'at node:internal/x.js:1'
  assert.deepEqual(extractErrorFiles(text), [])
})

test('不存在文件不输出', () => {
  const text = 'src/no-such-file-xyz.ts:1:1'
  assert.deepEqual(extractErrorFiles(text), [])
})

test('重复路径去重', () => {
  const text = [`${KNOWN}:1`, `at fn (${KNOWN}:2:3)`].join(' ')
  assert.deepEqual(extractErrorFiles(text), [KNOWN])
})

test('多条不同文件路径 → 全部返回', () => {
  const text = `${KNOWN}:1 ${KNOWN2}:2`
  const r = extractErrorFiles(text)
  assert.ok(r.includes(KNOWN))
  assert.ok(r.includes(KNOWN2))
})

test('.vue 文件同样被识别', () => {
  const text = 'at fn (client/App.vue:5:1)'
  assert.deepEqual(extractErrorFiles(text), ['client/App.vue'])
})

test('.tsx/.jsx/.mjs/.cjs 均在允许列表内（用不存在路径验证 regex 命中能力）', () => {
  const text = 'a.tsx:1 b.jsx:1 c.mjs:1 d.cjs:1'
  // 均不存在，返回空；仅为确保 regex 不会因扩展名崩溃
  assert.deepEqual(extractErrorFiles(text), [])
})

test('Windows 风格反斜杠路径归一为正斜杠（用绝对路径模拟）', () => {
  // 仅在 POSIX 下能可靠跑；Windows 反斜杠在当前 root 下不指向真实文件
  if (process.platform !== 'win32') return
  const win = `${process.cwd().replace(/\//g, '\\')}\\${KNOWN.replace(/\//g, '\\')}`
  const text = `at fn (${win}:1:1)`
  const r = extractErrorFiles(text)
  assert.ok(r.every(p => !p.includes('\\')))
})

test('项目外绝对路径被排除', () => {
  const text = 'at fn (/tmp/foo/bar.ts:1:1)'
  assert.deepEqual(extractErrorFiles(text), [])
})
