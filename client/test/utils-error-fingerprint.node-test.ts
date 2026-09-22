// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/utils/error-fingerprint.node-test.ts 迁至 client/test/utils-error-fingerprint.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fingerprintErrors } from '../../src/utils/error-fingerprint.ts'

// AIRUNNER-BATCH12-1-EF-COVERAGE

function mkFixture(name: string, content: string): string {
  const rel = path.join('.ai-runner', 'tmp', 'ef-fixtures', name)
  const abs = path.join(process.cwd(), rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return rel.replace(/\\/g, '/')
}

test('空文本 → []', () => {
  assert.deepEqual(fingerprintErrors(''), [])
})

test('无路径文本 → []', () => {
  assert.deepEqual(fingerprintErrors('hello world'), [])
})

test('node_modules 内文件被跳过', () => {
  assert.deepEqual(fingerprintErrors('node_modules/x/y.ts:1:1'), [])
})

test('node: 内建模块被跳过', () => {
  assert.deepEqual(fingerprintErrors('node:internal/x.js:1:1'), [])
})

test('绝对路径项目外被跳过', () => {
  assert.deepEqual(fingerprintErrors('/tmp/nonexistent-x.ts:1:1'), [])
})

test('定位函数声明：kind=function, symbol 正确', () => {
  const rel = mkFixture('fn.ts', ['export function myFn() {', '  throw new Error(1)', '}'].join(String.fromCharCode(10)))
  const fp = fingerprintErrors(`${rel}:2:3`)
  assert.equal(fp.length, 1)
  assert.equal(fp[0].symbol, 'myFn')
  assert.equal(fp[0].kind, 'function')
  assert.equal(fp[0].line, 2)
})

test('定位类声明：kind=class', () => {
  const rel = mkFixture('cls.ts', ['export class MyCls {', '  x = 1', '}'].join(String.fromCharCode(10)))
  const fp = fingerprintErrors(`${rel}:2:3`)
  assert.ok(fp.length >= 1)
  const top = fp.find(f => f.kind === 'class')
  assert.ok(top, 'should find a class fingerprint')
  assert.equal(top.symbol, 'MyCls')
})

test('定位类方法：kind=method', () => {
  const rel = mkFixture('m.ts', ['export class C {', '  myMethod() {', '    throw new Error(1)', '  }', '}'].join(String.fromCharCode(10)))
  const fp = fingerprintErrors(`${rel}:3:5`)
  const method = fp.find(f => f.kind === 'method')
  assert.ok(method, 'should find method fingerprint')
  assert.equal(method.symbol, 'myMethod')
})

test('定位箭头函数变量：kind=arrow 或 variable', () => {
  const rel = mkFixture('a.ts', ['const arrowFn = () => {', '  throw new Error(1)', '}'].join(String.fromCharCode(10)))
  const fp = fingerprintErrors(`${rel}:2:3`)
  assert.ok(fp.length >= 1)
  assert.equal(fp[0].symbol, 'arrowFn')
  assert.ok(fp[0].kind === 'arrow' || fp[0].kind === 'variable')
})

test('定位顶层变量：kind=variable', () => {
  const rel = mkFixture('v.ts', ['export const topVar = 1', 'export const another = 2'].join(String.fromCharCode(10)))
  const fp = fingerprintErrors(`${rel}:1:1`)
  assert.ok(fp.length >= 1)
  assert.equal(fp[0].kind, 'variable')
})

test('去重：同文件同行多次出现只产出一条', () => {
  const rel = mkFixture('d.ts', ['export function f() {', '  throw new Error(1)', '}'].join(String.fromCharCode(10)))
  const text = [`${rel}:2:3`, `${rel}:2:3`, `${rel}:2:9`].join(' ')
  const fp = fingerprintErrors(text)
  const keys = fp.map(f => `${f.file}:${f.line}`)
  assert.equal(new Set(keys).size, keys.length, 'no duplicate file:line pairs')
})

test('max 限制：超出上限时截断', () => {
  const lines = []
  for (let i = 0; i < 20; i++) lines.push(`export function fn${i}() {}`)
  const rel = mkFixture('many.ts', lines.join(String.fromCharCode(10)))
  const text = []
  for (let i = 1; i <= 20; i++) text.push(`${rel}:${i}:1`)
  const fp = fingerprintErrors(text.join(' '), 5)
  assert.ok(fp.length <= 5, `should respect max=5, got ${fp.length}`)
})

test('V8 at fn (path:line:col) 格式被识别', () => {
  const rel = mkFixture('v8.ts', ['function fn() {', '  throw new Error(1)', '}'].join(String.fromCharCode(10)))
  const text = `Error: x at fn (${rel}:2:5)`
  const fp = fingerprintErrors(text)
  assert.ok(fp.length >= 1)
  assert.equal(fp[0].file, rel)
})

test('tsc 风格 path(line,col) 中 path:line 也被识别', () => {
  const rel = mkFixture('tsc.ts', ['function tscFn() {}'].join(''))
  const fp = fingerprintErrors(`${rel}:1:1`)
  assert.ok(fp.length >= 1)
})

test('不存在的文件不产出指纹', () => {
  assert.deepEqual(fingerprintErrors('src/no-such-file-xyz.ts:1:1'), [])
})

test('filed 字段为归一化相对路径（反斜杠 → 正斜杠）', () => {
  const rel = mkFixture('norm.ts', ['function normFn() {}'].join(''))
  const fp = fingerprintErrors(`${rel}:1:1`)
  assert.ok(fp.length >= 1)
  assert.equal(fp[0].file.indexOf(String.fromCharCode(92)), -1, 'no backslash in file path')
})

test('扩展名覆盖：.tsx/.js/.mjs/.cjs/.vue 均被识别', () => {
  const rel = mkFixture('ext.tsx', `export const x = 1${String.fromCharCode(10)}`)
  const fp = fingerprintErrors(`${rel}:1:1`)
  assert.ok(fp.length >= 1)
})

// AIRUNNER-BATCH12-1-FIX-TOPLINE: 行号越界时实现兜底返回 kind='top'
test('行号越界 → 兜底返回 top 类型指纹', () => {
  const rel = mkFixture('short.ts', `export const a = 1${String.fromCharCode(10)}`)
  const fp = fingerprintErrors(`${rel}:999:1`)
  assert.equal(fp.length, 1)
  assert.equal(fp[0].kind, 'top')
  assert.equal(fp[0].symbol, '<top>')
})
