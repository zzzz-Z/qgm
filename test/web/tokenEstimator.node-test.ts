// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/tokenEstimator.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/tokenEstimator.node-test.ts 迁至 test/tokenEstimator.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { estimateTokens, fallbackEstimate } from '../../client/utils/tokenEstimator.ts'

// AIRUNNER-BATCH16-2-TOKEN-EST

// ============ fallbackEstimate ============
test('fallbackEstimate: 空字符串 → 0', () => {
  assert.equal(fallbackEstimate(''), 0)
})

test('fallbackEstimate: 纯空白 → 0', () => {
  assert.equal(fallbackEstimate('   '), 0)
})

test('fallbackEstimate: 单个短英文单词 → 1', () => {
  assert.equal(fallbackEstimate('hi'), 1)
})

test('fallbackEstimate: 英文 6 字符 → 1', () => {
  assert.equal(fallbackEstimate('abcdef'), 1)
})

test('fallbackEstimate: 英文 7 字符 → ceil(7/5) = 2', () => {
  assert.equal(fallbackEstimate('abcdefg'), 2)
})

test('fallbackEstimate: 英文 10 字符 → ceil(10/5) = 2', () => {
  assert.equal(fallbackEstimate('abcdefghij'), 2)
})

test('fallbackEstimate: 多个短单词各自累加', () => {
  // 'a b c' → 三个 1 字符 word 各 +1 → 3
  assert.equal(fallbackEstimate('a b c'), 3)
})

test('fallbackEstimate: 数字按 ceil(len/3) 计', () => {
  assert.equal(fallbackEstimate('1'), 1)
  assert.equal(fallbackEstimate('12'), 1)
  assert.equal(fallbackEstimate('123'), 1)
  assert.equal(fallbackEstimate('1234'), 2)
  assert.equal(fallbackEstimate('123456'), 2)
  assert.equal(fallbackEstimate('1234567'), 3)
})

test('fallbackEstimate: 标点每个按 1', () => {
  assert.equal(fallbackEstimate('!'), 1)
  assert.equal(fallbackEstimate('!@#'), 3)
})

test('fallbackEstimate: 中文字符按 ceil(count*0.7) 计', () => {
  // 1 个中文 → ceil(0.7) = 1
  assert.equal(fallbackEstimate('中'), 1)
  // 2 个中文 → ceil(1.4) = 2
  assert.equal(fallbackEstimate('中文'), 2)
  // 10 个中文 → ceil(7) = 7
  assert.equal(fallbackEstimate('一二三四五六七八九十'), 7)
})

test('fallbackEstimate: 中英混合累加', () => {
  // '中' + ' ' + 'abc' → ceil(0.7)=1 + 1 = 2
  assert.equal(fallbackEstimate('中 abc'), 2)
})

test('fallbackEstimate: 单调性：更长文本估计值不减少', () => {
  const a = fallbackEstimate('hello')
  const b = fallbackEstimate('hello world')
  const c = fallbackEstimate('hello world 更多内容')
  assert.ok(a <= b)
  assert.ok(b <= c)
})

test('fallbackEstimate: 非负整数', () => {
  for (const s of ['', 'a', '中', '!', '1234567890', 'hello world hello world']) {
    const n = fallbackEstimate(s)
    assert.ok(Number.isInteger(n) && n >= 0, `got ${n} for ${JSON.stringify(s)}`)
  }
})

// ============ estimateTokens ============
test('estimateTokens: 空字符串 → 0（不发 tokenizer）', () => {
  assert.equal(estimateTokens(''), 0)
})

test('estimateTokens: 非空文本 → 正数（tokenizer 或 fallback）', () => {
  const n = estimateTokens('hello world')
  assert.ok(n > 0, `expect positive, got ${n}`)
})

test('estimateTokens: 同输入返回同值（缓存/确定性）', () => {
  const a = estimateTokens('stable input')
  const b = estimateTokens('stable input')
  assert.equal(a, b)
})
