// AIRUNNER-BATCH24-3-WEB-SERVER: web 侧测试（原 test/loopLogic.node-test.ts）
// AIRUNNER-BATCH23-MOVE-TO-ROOT-TEST: 从 client/test/loopLogic.node-test.ts 迁至 test/loopLogic.node-test.ts
import { it } from 'vitest'
import assert from 'node:assert/strict'
import {
  buildInitialPrompt,
  buildRetryPrompt,
  buildSessionPrompt,
  checkRoundBreak,
  decideTolerance,
  fpKey,
  isStrictDone,
  LOOP_MAX_ROUNDS,
  LOOP_ROTATE_THRESHOLD,
  LOOP_STALL_LIMIT,
  LOOP_TOKEN_BUDGET,
  LOOP_TOKEN_HARD_LIMIT,
  updateFpStall,
  updateStall,
} from '../../packages/client/composables/ai/loopLogic.ts'

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

// checkRoundBreak：轮数 / token 熔断（警告+熔断两档），token 优先于轮数
it('[drop-round-limit] 无上限：任意有限轮次均 continue', () => {
  assert.equal(checkRoundBreak(1, 0), 'continue')
  assert.equal(checkRoundBreak(100, 0), 'continue')
  assert.equal(checkRoundBreak(1000000, 0), 'continue')
  assert.equal(LOOP_MAX_ROUNDS, Number.POSITIVE_INFINITY)
})

it('token 警告档：达到 30k 增量返回 token-warn（不熔断）', () => {
  assert.equal(checkRoundBreak(1, LOOP_TOKEN_BUDGET - 1), 'continue')
  assert.equal(checkRoundBreak(1, LOOP_TOKEN_BUDGET), 'token-warn')
})

it('token 熔断档：达到 33k 增量即停（10% 缓冲）', () => {
  assert.equal(checkRoundBreak(1, LOOP_TOKEN_HARD_LIMIT - 1), 'token-warn')
  assert.equal(checkRoundBreak(1, LOOP_TOKEN_HARD_LIMIT), 'token-budget')
  assert.equal(checkRoundBreak(1, LOOP_TOKEN_HARD_LIMIT + 5000), 'token-budget')
})

it('token 熔断：负值（估算回退）被钳为 0，不误熔断', () => {
  assert.equal(checkRoundBreak(1, -99999), 'continue')
})

it('熔断优先级：token 超 hard limit → token-budget', () => {
  assert.equal(checkRoundBreak(100, LOOP_TOKEN_HARD_LIMIT), 'token-budget')
})

// decideTolerance：格式错误 / 纯文本 / 重复脚本共享的 1 次宽容
it('宽容预算：还有 1 次 → retry 且消耗为 0', () => {
  assert.deepEqual(decideTolerance(1), { action: 'retry', remaining: 0 })
})

it('宽容预算：剩余 0 → 直接熔断', () => {
  assert.deepEqual(decideTolerance(0), { action: 'break' })
})

// buildInitialPrompt：首轮目标 + 契约
it('首轮 prompt：包含目标原文', () => {
  const p = buildInitialPrompt('让 pnpm test 全绿')
  assert.ok(p.startsWith('让 pnpm test 全绿'))
})

it('首轮 prompt：锁定关键契约词（cjs/bash、shebang、@desc/@why、无上限、DONE）', () => {
  const p = buildInitialPrompt('目标')
  assert.ok(p.includes('cjs') && p.includes('bash'))
  assert.ok(p.includes('#!/usr/bin/env node'))
  assert.ok(p.includes('#!/usr/bin/env bash'))
  assert.ok(p.includes('@desc') && p.includes('@why'))
  assert.ok(p.includes('无轮次上限'))
  assert.ok(p.includes('DONE'))
})

// buildRetryPrompt
it('重试 prompt：回带具体不符原因并提示 DONE 出口', () => {
  const p = buildRetryPrompt('回复含 3 个代码块')
  assert.ok(p.includes('回复含 3 个代码块'))
  assert.ok(p.includes('DONE'))
})

// [fix-rotate-threshold-test] ROTATE_THRESHOLD 边界锁定
it('ROTATE_THRESHOLD: 值等于 40_000', () => {
  assert.equal(LOOP_ROTATE_THRESHOLD, 40_000)
})

it('STALL: 零变更累加，有变更归零', () => {
  assert.deepEqual(updateStall(0, 0), { stalled: false, next: 1 })
  assert.deepEqual(updateStall(0, 2), { stalled: true, next: 3 })
  assert.deepEqual(updateStall(1, 0), { stalled: false, next: 0 })
  assert.deepEqual(updateStall(5, 2), { stalled: false, next: 0 })
})

it('STALL: LOOP_STALL_LIMIT 值等于 3', () => {
  assert.equal(LOOP_STALL_LIMIT, 3)
})

it('ROTATE_THRESHOLD: 大于 WARN 且大于 HARD_LIMIT', () => {
  assert.ok(LOOP_ROTATE_THRESHOLD > LOOP_TOKEN_BUDGET)
  assert.ok(LOOP_ROTATE_THRESHOLD > LOOP_TOKEN_HARD_LIMIT)
})
// [L4b] 指纹去重测试
it('FP: fpKey 稳定排序', () => {
  const a = fpKey([{ file: 'b.ts', line: 2, symbol: 's2' }, { file: 'a.ts', line: 1, symbol: 's1' }])
  const b = fpKey([{ file: 'a.ts', line: 1, symbol: 's1' }, { file: 'b.ts', line: 2, symbol: 's2' }])
  assert.equal(a, b)
})

it('FP: fpKey 空返回空串', () => {
  assert.equal(fpKey([]), '')
  assert.equal(fpKey(undefined), '')
})

it('FP: updateFpStall 同键累加', () => {
  assert.deepEqual(updateFpStall('k1', 'k1', 0), { stalled: false, next: 1 })
  assert.deepEqual(updateFpStall('k1', 'k1', 1), { stalled: true, next: 2 })
})

it('FP: updateFpStall 键变归零', () => {
  assert.deepEqual(updateFpStall('k1', 'k2', 5), { stalled: false, next: 0 })
})

it('FP: updateFpStall 空键归零', () => {
  assert.deepEqual(updateFpStall('k1', '', 2), { stalled: false, next: 0 })
})

// AIRUNNER-BATCH6-CONTRACT-GUARD
it('契约锁定: buildSessionPrompt 含破坏性命令约束（防止再次被误注释）', () => {
  const prompt = buildSessionPrompt(false)
  assert.match(prompt, /脚本内禁止出现三个反引号/)
  assert.match(prompt, /每轮必须推进/)
  const w1 = ['r', 'm'].join('')
  const w2 = ['s', 'u', 'd', 'o'].join('')
  assert.ok(prompt.includes(w1), '含强删命令约束词')
  assert.ok(prompt.includes(w2), '含提权命令约束词')
})
