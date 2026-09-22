// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/contextErrorLocations.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/contextErrorLocations.node-test.ts 迁至 test/contextErrorLocations.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseErrorLocations } from '../../client/utils/context-error-locations.ts'

// AIRUNNER-BATCH16-3-SPLIT-ERR-LOCS

test('空文本 → 空 Map', () => {
  const m = parseErrorLocations('')
  assert.equal(m.size, 0)
})

test('纯文本无路径 → 空 Map', () => {
  assert.equal(parseErrorLocations('hello world').size, 0)
})

test('单条 path:line → 1 项', () => {
  const m = parseErrorLocations('src/foo.ts:10')
  assert.equal(m.size, 1)
  const set = m.get('src/foo.ts')
  assert.ok(set)
  assert.equal(set.has(10), true)
})

test('path:line:col 提取 line 而非 col', () => {
  const m = parseErrorLocations('src/a.ts:42:7')
  const set = m.get('src/a.ts')
  assert.ok(set && set.has(42))
  assert.equal(set.has(7), false)
})

test('多行累加：同文件多行收在一个 Set', () => {
  const m = parseErrorLocations('src/a.ts:1 src/a.ts:2 src/a.ts:3')
  const set = m.get('src/a.ts')
  assert.deepEqual([...(set || [])].sort((a, b) => a - b), [1, 2, 3])
})

test('多文件 → 各自 key', () => {
  const m = parseErrorLocations('src/a.ts:1 src/b.ts:2')
  assert.ok(m.has('src/a.ts'))
  assert.ok(m.has('src/b.ts'))
})

test('node_modules 路径被跳过', () => {
  const m = parseErrorLocations('node_modules/x/y.ts:1')
  assert.equal(m.size, 0)
})

test('node: 内建模块被跳过', () => {
  const m = parseErrorLocations('node:internal/x.js:1')
  assert.equal(m.size, 0)
})

test('反斜杠归一化为正斜杠', () => {
  const back = String.fromCharCode(92)
  const m = parseErrorLocations(`src${back}foo${back}a.ts:5`)
  assert.ok(m.has('src/foo/a.ts'))
})

test('0 或负行号被过滤', () => {
  const m1 = parseErrorLocations('a.ts:0')
  assert.equal(m1.size, 0)
})

test('支持 .vue / .tsx / .js 等扩展', () => {
  const m = parseErrorLocations('client/App.vue:3 src/a.tsx:4 x.mjs:5 y.cjs:6')
  assert.equal(m.size, 4)
})

test('无扩展名文本不误匹配', () => {
  assert.equal(parseErrorLocations('foo:12').size, 0)
})

test('行号非数字被过滤', () => {
  const m = parseErrorLocations('a.ts:x')
  assert.equal(m.size, 0)
})

test('绝对路径也被识别（去扩展关键字）', () => {
  const m = parseErrorLocations('/usr/app/src/a.ts:9')
  assert.ok(m.size >= 1)
})
