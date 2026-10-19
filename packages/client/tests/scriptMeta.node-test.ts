// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/scriptMeta.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/scriptMeta.node-test.ts 迁至 test/scriptMeta.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { detectLang, ensureScriptHead, parseScriptMeta } from '../../../packages/client/utils/scriptMeta'

// AIRUNNER-BATCH15-5-SCRIPT-META
const NL = String.fromCharCode(10)

test('parseScriptMeta: 空字符串 → 全字段空串', () => {
  // [meta-schema-unify-v1] 实现返回 8 字段；deepEqual 严格比较键集，4 字段断言长期红
  assert.deepEqual(parseScriptMeta(''), { desc: '', why: '', plan: '', state: '', done: '', mode: '', ctx: '', changes: '' })
})

test('parseScriptMeta: js 风格 // 注释解析', () => {
  const code = ['#!/usr/bin/env node', '// @desc: 解析脚本头', '// @why: 需要展示', '// @plan: b1', 'console.log(1)'].join(NL)
  const m = parseScriptMeta(code)
  assert.equal(m.desc, '解析脚本头')
  assert.equal(m.why, '需要展示')
  assert.equal(m.plan, 'b1')
  // [meta-schema-unify-v1] 输入无 `// @done` 行 → 实现按缺失字段返回空串；旧断言 '无错' 是历史残留
  assert.equal(m.done, '')
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

test('detectLang: 无 shebang 的缩进 # 注释 → js（判据基于首行 shebang）', () => {
  // [meta-schema-unify-v1] detectLang 与 core/post-run/shebang.ts 对齐：只看首行 #!，不用注释前缀判语言；
  // 旧断言 'bash' 源于早期「注释前缀」实现，已被 shebang 契约取代
  assert.equal(detectLang('   # @desc: y'), 'js')
})

test('detectLang: 空字符串 → js', () => {
  assert.equal(detectLang(''), 'js')
})

// [script-head-autofill-v1] 信封 desc/why 补齐脚本头：/run 的头契约缺 @desc/@why 即 400 拒收
test('ensureScriptHead: 无头 → 用信封字段补齐，且 parseScriptMeta 可读回', () => {
  const out = ensureScriptHead('console.log(1)', '收尾探针', '确认真实运行')
  const m = parseScriptMeta(out)
  assert.equal(m.desc, '收尾探针')
  assert.equal(m.why, '确认真实运行')
  assert.ok(out.endsWith('console.log(1)'), '正文须原样保留')
})

test('ensureScriptHead: 已有 @desc 则不重复注入，仅补缺失的 @why', () => {
  const out = ensureScriptHead(`// @desc 原头${NL}console.log(1)`, '新desc', '新why')
  assert.equal((out.match(/@desc\b/g) || []).length, 1)
  assert.equal(parseScriptMeta(out).why, '新why')
})

test('ensureScriptHead: shebang 必须留在首行（头注释插在其后）', () => {
  const out = ensureScriptHead(['#!/usr/bin/env node', 'console.log(1)'].join(NL), 'd', 'w')
  assert.equal(out.split(NL)[0], '#!/usr/bin/env node')
  assert.equal(detectLang(out), 'js')
})

test('ensureScriptHead: 两值均空 → 原样返回（手动运行路径不受影响）', () => {
  assert.equal(ensureScriptHead('console.log(1)'), 'console.log(1)')
  assert.equal(ensureScriptHead('console.log(1)', undefined, undefined), 'console.log(1)')
})
