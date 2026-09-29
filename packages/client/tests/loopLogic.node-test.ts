// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/loopLogic.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/loopLogic.node-test.ts 迁至 test/loopLogic.node-test.ts
// [remove-legacy-tests] 删除对 checkRoundBreak / fpKey / STALL / TOKEN_BUDGET 等已下线符号的僵尸用例
import { it } from 'vitest'
import assert from 'node:assert/strict'
import {
  buildRetryPrompt,
  decideTolerance,
  isStrictDone,
  LOOP_MAX_ROUNDS,
  LOOP_ROTATE_THRESHOLD,
} from '../composables/ai/loopLogic.js'

// isStrictDone（v6 §6.9 第 1 条）：必须整段 trim 后恰为 DONE
it('DONE 严格匹配：合法形态', () => {
  assert.equal(isStrictDone('DONE'), true)
  assert.equal(isStrictDone('  DONE  '), true)
  assert.equal(isStrictDone('DONE\n'), true)
  assert.equal(isStrictDone('\tDONE\t'), true)
})

it('DONE 严格匹配：含解释 / 小写 / 标点 均不算', () => {
  assert.equal(isStrictDone('done'), false)
  assert.equal(isStrictDone('DONE！'), false)
  assert.equal(isStrictDone('DONE.'), false)
  assert.equal(isStrictDone('this task is done'), false)
  assert.equal(isStrictDone('not done'), false)
  assert.equal(isStrictDone('DONE\nDONE'), true) // [contract] 首行 DONE，后续行忽略
  assert.equal(isStrictDone('好的，DONE'), false)
  assert.equal(isStrictDone('DONE\n（任务完成）'), true) // [contract] 首行 DONE + 总结行
  assert.equal(isStrictDone(''), false)
})

// decideTolerance：格式错误 / 纯文本 / 重复脚本共享的 1 次宽容
it('宽容预算：还有 1 次 → retry 且消耗为 0', () => {
  assert.deepEqual(decideTolerance(1), { action: 'retry', remaining: 0 })
})

it('宽容预算：剩余 0 → 直接熔断', () => {
  assert.deepEqual(decideTolerance(0), { action: 'break' })
})

// buildRetryPrompt
it('重试 prompt：回带具体不符原因并提示 DONE 出口', () => {
  const p = buildRetryPrompt('回复含 3 个代码块')
  assert.ok(p.includes('回复含 3 个代码块'))
  assert.ok(p.includes('DONE'))
})

// [drop-round-limit] LOOP_MAX_ROUNDS 保持 Infinity 兼容引用
it('LOOP_MAX_ROUNDS = Infinity', () => {
  assert.equal(LOOP_MAX_ROUNDS, Number.POSITIVE_INFINITY)
})

// [fix-rotate-threshold-test] ROTATE_THRESHOLD 边界锁定
it('ROTATE_THRESHOLD: 值等于 40_000', () => {
  assert.equal(LOOP_ROTATE_THRESHOLD, 40_000)
})
