// [strip-script-blocks-v1-test] 剥离脚本围栏块的判据
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { stripScriptBlocks } from '../utils/strip-script-blocks.js'

/** 构造三反引号围栏块 */
function fence(body: string): string {
  const F = String.fromCharCode(96).repeat(3)
  return `${F}js\n${body}\n${F}`
}

test('S1: 含 shebang 的脚本围栏块被整体剥离 ⇒ 空串', () => {
  const t = fence('#! /usr/bin/env node\n// @why x\nconsole.log(1)')
  assert.equal(stripScriptBlocks(t), '')
})

test('S2: 含 @desc 的脚本围栏块被剥离（无 shebang 也算）', () => {
  const t = fence('// @desc 做某事\n// @why 因为\nconst a = 1')
  assert.equal(stripScriptBlocks(t), '')
})

test('S3: 普通代码示例（无脚本特征）原样保留', () => {
  const body = 'const a = 1\nconsole.log(a)'
  const t = fence(body)
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('const a = 1'), '无脚本特征的围栏块不得剥离')
})

test('S4: 未闭合围栏原样保留（流式中间态，不误吞）', () => {
  const F = String.fromCharCode(96).repeat(3)
  const t = `${F}js\n#! /usr/bin/env node\nconsole.log(1)`
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('console.log(1)'), '未闭合围栏不得剥离')
})

test('S5: 文本 + 脚本混合 ⇒ 只留文本', () => {
  const t = ['先说明一下：', '', fence('#! /usr/bin/env node\n// @why y\nconsole.log(1)'), '', '后记。'].join('\n')
  const out = stripScriptBlocks(t)
  assert.ok(out.includes('先说明一下'), '文本保留')
  assert.ok(out.includes('后记'), '文本保留')
  assert.ok(!out.includes('console.log'), '脚本正文被剥离')
})

test('S6: 空输入 ⇒ 空串（不抛）', () => {
  assert.equal(stripScriptBlocks(''), '')
  assert.equal(stripScriptBlocks('   '), '')
})
