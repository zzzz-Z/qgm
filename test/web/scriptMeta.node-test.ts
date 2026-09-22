// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/scriptMeta.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/scriptMeta.node-test.ts 迁至 test/scriptMeta.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { detectLang, parseScriptMeta } from '../../client/utils/scriptMeta.ts'

// AIRUNNER-BATCH15-5-SCRIPT-META
const NL = String.fromCharCode(10)

test('parseScriptMeta: 空字符串 → 全字段空串', () => {
  assert.deepEqual(parseScriptMeta(''), { desc: '', why: '', plan: '', done: '' })
})

test('parseScriptMeta: js 风格 // 注释解析', () => {
  const code = ['#!/usr/bin/env node', '// @desc: 解析脚本头', '// @why: 需要展示', '// @plan: b1', '// @done: 无错', 'console.log(1)'].join(NL)
  const m = parseScriptMeta(code)
  assert.equal(m.desc, '解析脚本头')
  assert.equal(m.why, '需要展示')
  assert.equal(m.plan, 'b1')
  assert.equal(m.done, '无错')
})

test('parseScriptMeta: bash 风格 # 注释解析', () => {
  const code = ['#!/usr/bin/env bash', '# @desc: b任务', '# @why: 因为x'].join(NL)
  const m = parseScriptMeta(code)
  assert.equal(m.desc, 'b任务')
  assert.equal(m.why, '因为x')
})

test('parseScriptMeta: 缺失字段返回空串', () => {
  const m = parseScriptMeta('console.log(1)')
  assert.equal(m.desc, '')
  assert.equal(m.why, '')
})

test('parseScriptMeta: 冒号后无内容 → 空串（不匹配）', () => {
  const m = parseScriptMeta('// @desc: ')
  assert.equal(m.desc, '')
})

test('parseScriptMeta: 前导空白容忍', () => {
  const code = '   // @desc: 缩进解析'
  assert.equal(parseScriptMeta(code).desc, '缩进解析')
})

test('parseScriptMeta: 冒号前有空白容忍', () => {
  const code = '// @desc   : 空白容忍'
  assert.equal(parseScriptMeta(code).desc, '空白容忍')
})

test('parseScriptMeta: 首值优先（match 取首个）', () => {
  const code = ['// @desc: first', '// @desc: second'].join(NL)
  assert.equal(parseScriptMeta(code).desc, 'first')
})

test('detectLang: js 脚本无 # 注释 → js', () => {
  assert.equal(detectLang(`// @desc: x${NL}console.log(1)`), 'js')
})

test('detectLang: bash shebang + # 注释 → bash', () => {
  assert.equal(detectLang(`#!/usr/bin/env bash${NL}# @desc: x`), 'bash')
})

test('detectLang: 无 @desc/@why 的 # 行 → 仍 js（regex 要求 @desc|@why）', () => {
  assert.equal(detectLang('# just a comment'), 'js')
})

test('detectLang: 缩进的 # @desc → bash', () => {
  assert.equal(detectLang('   # @desc: y'), 'bash')
})

test('detectLang: 空字符串 → js', () => {
  assert.equal(detectLang(''), 'js')
})
