#!/usr/bin/env node
// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/scriptInboxLogic.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/scriptInboxLogic.node-test.ts 迁至 test/scriptInboxLogic.node-test.ts
// @desc Characterization Test for inbox-parse (normalizeForHash + parseMeta)
// @why 锁定抽取后行为：空行/注释剔除、去空白、@desc/@why 首值截断语义

import { test } from 'vitest'
import assert from 'node:assert/strict'
import { normalizeForHash, parseMeta } from '../../../packages/client/composables/runner/inbox-parse'

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

// [script-identity-v1] @desc / @why 必须参与 hash：它们是脚本身份而非可随意改的注释。
// [WHY] 原实现剥掉全部注释 ⇒ 「同骨架不同 @desc」的分阶段脚本 hash 相同 ⇒ 第 2 次起被静默去重
//   （arrive.jsonl 记 reason=dedup，runner/reject 双静默，用户体感「脚本没执行」）。
// [CONSTRAINT] 变异：把 filter 里的 @desc/@why 例外删掉 ⇒ 本用例必红。
test('normalizeForHash：@desc/@why 参与 hash（同骨架不同 desc 视为不同脚本）', () => {
  const A = '// @desc 阶段一\n// @why 理由一\nconst r = 1'
  const B = '// @desc 阶段二\n// @why 理由二\nconst r = 1'
  assert.notEqual(normalizeForHash(A), normalizeForHash(B), '不同 @desc/@why 被误判为同一脚本 ⇒ 分阶段脚本会被静默去重')
})

test('normalizeForHash：实现差异仍参与 hash（同 desc 不同代码）', () => {
  const A = '// @desc 同一描述\n// @why 同一理由\nconst r = 1'
  const B = '// @desc 同一描述\n// @why 同一理由\nconst r = 2'
  assert.notEqual(normalizeForHash(A), normalizeForHash(B), '实现差异未参与 hash ⇒ 真新脚本会被误判为重复')
})

test('normalizeForHash：@desc/@why 之外的注释仍被剥离', () => {
  const A = '// @desc x\n// @why y\n// 普通注释一\nconst r = 1'
  const B = '// @desc x\n// @why y\n// 普通注释二\nconst r = 1'
  assert.equal(normalizeForHash(A), normalizeForHash(B), '普通注释应被归一化（保持既有语义）')
})

test('normalizeForHash：shebang 仍被剥离（不参与 hash）', () => {
  const A = '// @desc x\n// @why y\nconst r = 1'
  const B = '#!/usr/bin/env node\n// @desc x\n// @why y\nconst r = 1'
  assert.equal(normalizeForHash(A), normalizeForHash(B), 'shebang 应被剥离')
})
