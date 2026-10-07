// [board-unclosed-v1] WO-20261007-01 段二承重判据：指标只取 clear==='finish'。
// [WHY] finish 与 init 两次清桶请求体逐字相同，不区分则每个循环贡献两个样本，
//   而 init 几乎恒为 0 ⇒ 分母被稀释约一半。变异：去掉 finish 过滤 ⇒ 本例必红。
import { createRequire } from 'node:module'
import { test } from 'vitest'
import assert from 'node:assert/strict'

const require_ = createRequire(import.meta.url)
const { computeUnclosed } = require_('../../../scripts/board-unclosed.cjs') as {
  computeUnclosed: (rows: Array<Record<string, unknown>>) => {
    finishTotal: number
    finishDirty: number
    initTotal: number
    legacyTotal: number
  }
}

test('只取 finish：init 样本不入分母（变异：去掉过滤 ⇒ 本例红）', () => {
  const rows = [
    { mode: 'set', clear: 'finish', clearedUnclosed: 2 },
    { mode: 'set', clear: 'finish', clearedUnclosed: 0 },
    { mode: 'set', clear: 'init', clearedUnclosed: 0 },
    { mode: 'set', clear: 'init', clearedUnclosed: 0 },
    { mode: 'set' },
  ]
  const r = computeUnclosed(rows)
  assert.equal(r.finishTotal, 2, 'finish 样本应为 2')
  assert.equal(r.finishDirty, 1, '未收口应为 1')
  assert.equal(r.initTotal, 2, 'init 样本单独计')
  assert.equal(r.legacyTotal, 1, 'legacy 无 clear 字段单独计')
  // 反证：若把 init 也算进分母，率会从 1/2=50% 稀释成 1/4=25%
  assert.notEqual(r.finishTotal, 4, 'init 不得混入分母 —— 混入即稀释')
})
