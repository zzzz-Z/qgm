// [picker-match-score-v1] @ 选择器的匹配评分守卫。
// [WHY] 原实现只做 `label.includes(q)` 后按「技能全在前、文件全在后」排列，
//   输入 `pb` 匹配不到 `prompt-builder.ts`，且精确命中项可能被 slice(0,200) 截掉。
// [判据承重] 把 scoreMatch 改成恒返回 1 ⇒ 除「空查询」外的所有用例必红。
import assert from 'node:assert/strict'

import { it } from 'vitest'

import { scoreMatch } from '../components/script/file-picker.js'

const DEEP = 'packages/client/components/script/prompt-builder.ts'

it('scoreMatch：空查询返回 1（全部保留，不参与排序区分）', () => {
  assert.equal(scoreMatch(DEEP, ''), 1)
})

it('scoreMatch：完全不匹配返回 0', () => {
  assert.equal(scoreMatch(DEEP, 'zzzz-not-exist'), 0)
})

it('scoreMatch：完全相等 100 > 去扩展名相等 95 > 文件名前缀 90', () => {
  assert.equal(scoreMatch('prompt-builder.ts', 'prompt-builder.ts'), 100)
  assert.equal(scoreMatch(DEEP, 'prompt-builder'), 95, '去 .ts 后与文件名相等')
  assert.equal(scoreMatch(DEEP, 'prompt'), 90, '文件名前缀')
  assert.ok(scoreMatch(DEEP, 'prompt-builder.ts') > scoreMatch(DEEP, 'prompt'))
})

it('scoreMatch：任意路径段首 80，且高于纯子串 50', () => {
  assert.equal(scoreMatch(DEEP, 'script'), 80, '路径段 script 的段首匹配')
  assert.equal(scoreMatch('abcdef', 'cde'), 50, '中段子串')
  // [CONSTRAINT] 同为路径段首时评分相同（都是 80）——scoreMatch 不含「段位置敏感」，
  //   因为它对 @ 选择器没有可论证的收益：输入 script 时 prompt-builder.ts 与
  //   script.ts 谁更该排前，取决于用户意图而非路径深度。
  assert.equal(scoreMatch(DEEP, 'script'), scoreMatch(DEEP, 'components'), '不同段首同分')
})

it('scoreMatch：词首缩写能命中（pb → Prompt-Builder），评分 40', () => {
  // 这是原实现完全缺失的能力：`includes('pb')` 对 prompt-builder.ts 返回 false
  assert.equal(scoreMatch(DEEP, 'pb'), 40)
  assert.equal(scoreMatch(DEEP, 'pccspb'), 40, '整条路径的词首缩写')
})

it('scoreMatch：大小写不敏感（两侧都归一化）', () => {
  assert.equal(scoreMatch('Prompt-Builder.ts', 'PROMPT'), 90)
  assert.equal(scoreMatch('PROMPT-BUILDER.TS', 'prompt'), 90)
})

it('scoreMatch：排序语义 —— 精确命中必须排在缩写命中之前', () => {
  const exact = scoreMatch('pb.ts', 'pb')
  const acronym = scoreMatch(DEEP, 'pb')
  assert.ok(exact > acronym, `精确命中(${exact}) 必须高于缩写命中(${acronym})`)
})
