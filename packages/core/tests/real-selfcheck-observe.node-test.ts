// [real-selfcheck-observe-v1] 守卫 computeCompliance 的 hasRealSelfCheck 判据
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { computeCompliance } from '../src/post-run/run-compliance.js'

const SHEBANG = '#! /usr/bin/env node'

test('命中 __AI__.syntaxCheck 调用', () => {
  const f = computeCompliance(`${SHEBANG}\n__AI__.syntaxCheck(src, 'a.ts')`, 'd')
  assert.equal(f.hasRealSelfCheck, true)
})

test('命中 __AI__.typeCheck 调用', () => {
  const f = computeCompliance(`${SHEBANG}\n__AI__.typeCheck()`, 'd')
  assert.equal(f.hasRealSelfCheck, true)
})

test('不命中 assert 旧判据', () => {
  const f = computeCompliance(`${SHEBANG}\n__AI__.assert(true, 'x')`, 'd')
  assert.equal(f.hasRealSelfCheck, false)
  assert.equal(f.hasSelfCheck, true)
})

test('空脚本不命中', () => {
  const f = computeCompliance(SHEBANG, 'd')
  assert.equal(f.hasRealSelfCheck, false)
})
