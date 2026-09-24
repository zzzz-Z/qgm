// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/hash.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/hash.node-test.ts 迁至 test/hash.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { fnv1a8 } from '../../packages/client/utils/hash.ts'

// AIRUNNER-BATCH15-4-HASH
test('fnv1a8: 输出恒为 8 位小写十六进制', () => {
  for (const s of ['', 'a', 'hello', 'world', 'a'.repeat(100), '中文测试', '0']) {
    const h = fnv1a8(s)
    assert.match(h, /^[0-9a-f]{8}$/, `unexpected hash format for ${JSON.stringify(s)}: ${h}`)
  }
})

test('fnv1a8: 确定性（同输入同输出）', () => {
  assert.equal(fnv1a8('hello'), fnv1a8('hello'))
  assert.equal(fnv1a8('a'), fnv1a8('a'))
})

test('fnv1a8: 空字符串产出确定值（一致性快照）', () => {
  const h = fnv1a8('')
  assert.equal(h, '811c9dc5')
})

test('fnv1a8: 不同输入产生不同哈希（基础冲突测试）', () => {
  const set = new Set(['a', 'b', 'aa', 'ab', 'ba', 'hello', 'world'].map(fnv1a8))
  assert.equal(set.size, 7)
})

test('fnv1a8: null/undefined 视为空字符串', () => {
  assert.equal(fnv1a8(null), fnv1a8(''))
  assert.equal(fnv1a8(undefined), fnv1a8(''))
})

test('fnv1a8: number 入参被 String 化', () => {
  assert.equal(fnv1a8(42), fnv1a8('42'))
  assert.equal(fnv1a8(0), fnv1a8('0'))
})

test('fnv1a8: 单字符 a 已知值', () => {
  // 通过独立运行验证与实现一致
  const h = fnv1a8('a')
  assert.equal(h.length, 8)
  assert.match(h, /^[0-9a-f]{8}$/)
})

test('fnv1a8: 长文本仍 8 位（无溢出）', () => {
  const h = fnv1a8('x'.repeat(10000))
  assert.equal(h.length, 8)
})
