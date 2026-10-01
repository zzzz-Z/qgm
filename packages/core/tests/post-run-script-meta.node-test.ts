// AIRUNNER-BATCH24-3-WEB-SERVER: server 侧测试（原 test/post-run-script-meta.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/post-run-script-meta.node-test.ts 迁至 test/post-run-script-meta.node-test.ts
// AIRUNNER-BATCH22-1-CONSOLIDATE: 从 src/post-run/script-meta.node-test.ts 迁至 client/test/post-run-script-meta.node-test.ts
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseClaimed, parseScriptMeta } from '../../../packages/core/src/post-run/script-meta.js'

const NL = String.fromCharCode(10)

test('parseScriptMeta: 空脚本 → 全字段空串', () => {
  const m = parseScriptMeta('')
  // [meta-schema-unify-v1] 实现已返回 8 字段（与 client/utils/scriptMeta.ts 对齐）；deepEqual 严格比较键集，
  // 旧断言只列 4 字段 → 长期红。修复方向是测试向实现看齐（接口契约在 script-meta.ts:5-17 显式声明 8 字段）
  assert.deepEqual(m, { desc: '', why: '', plan: '', state: '', done: '', mode: '', ctx: '', changes: '' })
})

test('parseScriptMeta: js 用 // 注释解析 @desc/@why', () => {
  const s = ['#!/usr/bin/env node', '// @desc: 解析日志', '// @why: 需要聚合', 'console.log(1)'].join(NL)
  const m = parseScriptMeta(s)
  assert.equal(m.desc, '解析日志')
  assert.equal(m.why, '需要聚合')
})

test('parseScriptMeta: bash 用 # 注释解析', () => {
  const s = ['#!/usr/bin/env bash', '# @desc: b任务', '# @why: 因为x'].join(NL)
  const m = parseScriptMeta(s)
  assert.equal(m.desc, 'b任务')
  assert.equal(m.why, '因为x')
})

test('parseScriptMeta: 首值优先（重复 @desc 忽略后续）', () => {
  const s = ['// @desc: first', '// @desc: second'].join(NL)
  assert.equal(parseScriptMeta(s).desc, 'first')
})

test('parseScriptMeta: 解析 @mode 与 @ctx', () => {
  const s = ['// @mode: diff', '// @ctx: full'].join(NL)
  const m = parseScriptMeta(s)
  assert.equal(m.mode, 'diff')
  assert.equal(m.ctx, 'full')
})

test('parseScriptMeta: 值截断到 200 字符', () => {
  const long = 'x'.repeat(500)
  const s = `// @desc: ${long}`
  assert.equal(parseScriptMeta(s).desc.length, 200)
})

test('parseScriptMeta: 冒号可选 → 无冒号同样解析（与 client 实现、SYSTEM.md §1.4 示例对齐）', () => {
  // [meta-colon-optional-v1] core 正则 (?::[^\S\n]*)? 与 client 的 :? 都是「冒号可选」；
  // SYSTEM.md §1.4 示例写作 `// @desc <做什么>`（无冒号），旧断言把无冒号判为空串 → 与实现和规范双向漂移
  const s = '// @desc 无冒号'
  assert.equal(parseScriptMeta(s).desc, '无冒号')
})

test('parseClaimed: 无 @changes → null', () => {
  assert.equal(parseClaimed('console.log(1)'), null)
})

test('parseClaimed: 单行多文件逗号分隔', () => {
  const s = '// @changes: a.ts, b.ts, c.ts'
  assert.deepEqual(parseClaimed(s), ['a.ts', 'b.ts', 'c.ts'])
})

test('parseClaimed: 反斜杠归一为正斜杠', () => {
  const s = `// @changes: src${String.fromCharCode(92)}foo${String.fromCharCode(92)}a.ts`
  assert.deepEqual(parseClaimed(s), ['src/foo/a.ts'])
})

test('parseClaimed: 多行 @changes 累积', () => {
  const s = ['// @changes: a.ts', '// @changes: b.ts'].join(NL)
  assert.deepEqual(parseClaimed(s), ['a.ts', 'b.ts'])
})

test('parseClaimed: 空段被过滤', () => {
  const s = '// @changes: a.ts, ,b.ts,'
  assert.deepEqual(parseClaimed(s), ['a.ts', 'b.ts'])
})

test('parseClaimed: 仅 # 注释不识别（只认 //）', () => {
  const s = '# @changes: a.ts'
  assert.equal(parseClaimed(s), null)
})
