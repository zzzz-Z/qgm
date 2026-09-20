import { it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFeedback,
  buildInitialPrompt,
  buildRetryPrompt,
  checkRoundBreak,
  decideTolerance,
  isStrictDone,
  LOOP_FEEDBACK_TAIL,
  LOOP_MAX_ROUNDS,
  LOOP_TOKEN_BUDGET,
  LOOP_TOKEN_HARD_LIMIT,
  tailClip,
} from './composables/loopLogic.ts'
import type { FeedbackOutcome } from './composables/loopLogic.ts'

// ---------------------------------------------------------------------------
// isStrictDone（v6 §6.9 第 1 条）：必须整段 trim 后恰为 DONE
// ---------------------------------------------------------------------------
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
  assert.equal(isStrictDone('DONE\nDONE'), false)
  assert.equal(isStrictDone('好的，DONE'), false)
  assert.equal(isStrictDone('DONE\n（任务完成）'), false)
  assert.equal(isStrictDone(''), false)
})

// ---------------------------------------------------------------------------
// checkRoundBreak：轮数 / token 熔断（警告+熔断两档），token 优先于轮数
// ---------------------------------------------------------------------------
it('轮次熔断：1-7 轮继续，第 8 轮停止', () => {
  assert.equal(checkRoundBreak(1, 0), 'continue')
  assert.equal(checkRoundBreak(LOOP_MAX_ROUNDS - 1, 0), 'continue')
  assert.equal(checkRoundBreak(LOOP_MAX_ROUNDS, 0), 'round-limit')
  assert.equal(checkRoundBreak(LOOP_MAX_ROUNDS + 1, 0), 'round-limit')
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

it('熔断优先级：第 8 轮且 token 同时超 hard limit → token-budget', () => {
  assert.equal(checkRoundBreak(LOOP_MAX_ROUNDS, LOOP_TOKEN_HARD_LIMIT), 'token-budget')
})

// ---------------------------------------------------------------------------
// decideTolerance：格式错误 / 纯文本 / 重复脚本共享的 1 次宽容
// ---------------------------------------------------------------------------
it('宽容预算：还有 1 次 → retry 且消耗为 0', () => {
  assert.deepEqual(decideTolerance(1), { action: 'retry', remaining: 0 })
})

it('宽容预算：剩余 0 → 直接熔断', () => {
  assert.deepEqual(decideTolerance(0), { action: 'break' })
})

// ---------------------------------------------------------------------------
// tailClip
// ---------------------------------------------------------------------------
it('tailClip：短串原样返回', () => {
  assert.equal(tailClip('abc'), 'abc')
})

it('tailClip：超长只保留尾部，长度恰为上限', () => {
  const s = 'x'.repeat(LOOP_FEEDBACK_TAIL + 500)
  const r = tailClip(s)
  assert.equal(r.length, LOOP_FEEDBACK_TAIL)
  assert.equal(r, 'x'.repeat(LOOP_FEEDBACK_TAIL))
})

it('tailClip：保留尾部、丢弃头部（头尾各带独特标记）', () => {
  const s = `HEAD_TOKEN_${'a'.repeat(4000)}TAIL_MARK`
  const r = tailClip(s)
  assert.equal(r.length, LOOP_FEEDBACK_TAIL)
  assert.ok(r.endsWith('TAIL_MARK'))
  // 头部标记位于前 11 字符，截断窗口只保留后 3000 字符，必然已被丢弃
  assert.ok(!r.includes('HEAD_TOKEN'))
})

// ---------------------------------------------------------------------------
// buildInitialPrompt：首轮目标 + 契约
// ---------------------------------------------------------------------------
it('首轮 prompt：包含目标原文', () => {
  const p = buildInitialPrompt('让 pnpm test 全绿')
  assert.ok(p.startsWith('让 pnpm test 全绿'))
})

it('首轮 prompt：锁定关键契约词（cjs/bash、shebang、@desc/@why、8 轮、DONE）', () => {
  const p = buildInitialPrompt('目标')
  assert.ok(p.includes('cjs') && p.includes('bash'))
  assert.ok(p.includes('#!/usr/bin/env node'))
  assert.ok(p.includes('#!/usr/bin/env bash'))
  assert.ok(p.includes('@desc') && p.includes('@why'))
  assert.ok(p.includes(String(LOOP_MAX_ROUNDS)))
  assert.ok(p.includes('DONE'))
})

// ---------------------------------------------------------------------------
// buildRetryPrompt
// ---------------------------------------------------------------------------
it('重试 prompt：回带具体不符原因并提示 DONE 出口', () => {
  const p = buildRetryPrompt('回复含 3 个代码块')
  assert.ok(p.includes('回复含 3 个代码块'))
  assert.ok(p.includes('DONE'))
})

// ---------------------------------------------------------------------------
// buildFeedback：轮后回填
// ---------------------------------------------------------------------------
function cjsOutcome(over: Partial<FeedbackOutcome> = {}): FeedbackOutcome {
  return {
    lang: 'cjs',
    desc: '补 name',
    exit: 0,
    ok: true,
    stdout: 'updated a.vue\n',
    stderr: '',
    changeCount: 1,
    changedFiles: ['a.vue'],
    ...over,
  }
}

it('回填：cjs 成功包含类型/退出码/成功/变更文件', () => {
  const f = buildFeedback(cjsOutcome(), { nextRound: 2, tokenDelta: 0 })
  assert.ok(f.includes('类型: cjs'))
  assert.ok(f.includes('说明: 补 name'))
  assert.ok(f.includes('退出码: 0（成功）'))
  assert.ok(f.includes('变更: 1 个文件：a.vue'))
  assert.ok(f.includes('第 2/8 轮'))
  assert.ok(f.includes('0.0k/30k'))
  assert.ok(f.includes('熔断线 33k'))
})

it('回填：bash 结果不输出「变更」行', () => {
  const f = buildFeedback(
    cjsOutcome({ lang: 'bash', changeCount: 0, changedFiles: [], stdout: 'test passed' }),
    { nextRound: 3, tokenDelta: 1500 },
  )
  assert.ok(!f.includes('变更:'))
  assert.ok(f.includes('test passed'))
  assert.ok(f.includes('第 3/8 轮'))
  assert.ok(f.includes('1.5k/30k'))
})

it('回填：失败时标注失败并回带 stderr 尾部', () => {
  const f = buildFeedback(
    cjsOutcome({ exit: 1, ok: false, stderr: 'ERR_ASSERTION boom', stdout: '' }),
    { nextRound: 2, tokenDelta: 0 },
  )
  assert.ok(f.includes('退出码: 1（失败）'))
  assert.ok(f.includes('ERR_ASSERTION boom'))
})

it('回填：无 desc 时不出现「说明:」行', () => {
  const f = buildFeedback(cjsOutcome({ desc: '' }), { nextRound: 2, tokenDelta: 0 })
  assert.ok(!f.includes('说明:'))
})

it('回填：超长 stdout 截断到尾部 3000 字', () => {
  const longOut = `${'HEAD'.repeat(2000)}\nUNIQUE_END_TOKEN`
  const f = buildFeedback(cjsOutcome({ stdout: longOut }), { nextRound: 2, tokenDelta: 0 })
  assert.ok(f.includes('UNIQUE_END_TOKEN'))
  // 头部被截掉：'HEADHEAD...' 重复串不应完整保留 8000 字符
  assert.ok(!f.includes('HEAD'.repeat(1500)))
})

it('回填：变更文件列表最多展示 10 个', () => {
  const files = Array.from({ length: 15 }, (_, i) => `f${i}.vue`)
  const f = buildFeedback(cjsOutcome({ changeCount: 15, changedFiles: files }), { nextRound: 2, tokenDelta: 0 })
  assert.ok(f.includes('f0.vue') && f.includes('f9.vue'))
  assert.ok(!f.includes('f10.vue'))
  assert.ok(f.includes('变更: 15 个文件'))
})

it('回填：记忆锚点含目标与进度', () => {
  const f = buildFeedback(cjsOutcome(), { nextRound: 2, tokenDelta: 0, goal: '让 pnpm test 全绿', round: 1, max: 8 })
  assert.ok(f.includes('【锚】目标：让 pnpm test 全绿'))
  assert.ok(f.includes('进度 1/8'))
  assert.ok(f.includes('剩 7 轮'))
})

it('回填：无 goal 时无锚点行', () => {
  const f = buildFeedback(cjsOutcome(), { nextRound: 2, tokenDelta: 0 })
  assert.ok(!f.includes('【锚】'))
})

it('回填：userNote 注入', () => {
  const f = buildFeedback(cjsOutcome(), { nextRound: 2, tokenDelta: 0, userNote: '注意保留注释' })
  assert.ok(f.includes('【用户补充】注意保留注释'))
})

it('回填：无 userNote 时无用户补充行', () => {
  const f = buildFeedback(cjsOutcome(), { nextRound: 2, tokenDelta: 0 })
  assert.ok(!f.includes('【用户补充】'))
})

it('回填：末尾必含推进指令与 DONE 出口', () => {
  const f = buildFeedback(cjsOutcome(), { nextRound: 2, tokenDelta: 0 })
  assert.ok(f.includes('勿重复上轮脚本'))
  assert.ok(f.includes('DONE'))
})
