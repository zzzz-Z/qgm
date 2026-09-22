#!/usr/bin/env node
// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/scriptInboxLogic.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/scriptInboxLogic.node-test.ts 迁至 test/scriptInboxLogic.node-test.ts
// @desc Characterization Test for inbox-logic (normalizeForHash + parseMeta)
// @why 锁定抽取后行为：空行/注释剔除、去空白、@desc/@why 首值截断语义

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { normalizeForHash, parseMeta } from '../../client/composables/runner/inbox-logic.ts'

test('normalizeForHash 剔除空行与 // 注释行、压缩空白', () => {
  const src = ['// header', '', 'const a = 1', '  const b = 2  ', '// trailing'].join('\n')
  assert.equal(normalizeForHash(src), 'consta=1constb=2')
})

test('normalizeForHash 剔除 # 注释行（含 shebang）', () => {
  const src = ['#!/usr/bin/env bash', '# note', 'echo hi'].join('\n')
  assert.equal(normalizeForHash(src), 'echohi')
})

test('normalizeForHash 仅空白差异视为同一指纹', () => {
  const a = 'const x = 1\nconst y = 2'
  const b = 'const  x=1\n  const y=2  '
  assert.equal(normalizeForHash(a), normalizeForHash(b))
})

test('parseMeta js/cjs 用 //，取首个 @desc/@why', () => {
  const code = ['#!/usr/bin/env node', '// @desc: first desc', '// @why: first why', '// @desc: second (ignored)', 'console.log(1)'].join('\n')
  const m = parseMeta(code, 'cjs')
  assert.equal(m.desc, 'first desc')
  assert.equal(m.why, 'first why')
})

test('parseMeta bash 用 #', () => {
  const code = ['#!/usr/bin/env bash', '# @desc: b', '# @why: w', 'echo ok'].join('\n')
  const m = parseMeta(code, 'bash')
  assert.equal(m.desc, 'b')
  assert.equal(m.why, 'w')
})

test('parseMeta 缺失字段返回空串', () => {
  const m = parseMeta('console.log(1)', 'cjs')
  assert.equal(m.desc, '')
  assert.equal(m.why, '')
})

test('parseMeta 值截断到 200 字符', () => {
  const long = 'x'.repeat(500)
  const line = `// @desc: ${long}`
  const m = parseMeta(line, 'cjs')
  assert.equal(m.desc.length, 200)
})

test('parseMeta lang=js 与 cjs 行为一致', () => {
  const code = '// @why: because\nfoo'
  assert.deepEqual(parseMeta(code, 'js'), parseMeta(code, 'cjs'))
})
