// [loop-lessons-refresh-v1] buildLessonsQuery 纯函数单测：query 构造规则。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { buildLessonsQuery } from '../composables/ai/auto-loop/loop-lessons-fill'
import type { RoundOutcome } from '../composables/ai/auto-loop/types'

function mk(over: Partial<RoundOutcome>): RoundOutcome {
  return { lang: 'js', desc: '', exit: 0, ok: true, stdout: '', stderr: '', changeCount: 0, changedFiles: [], ...over }
}

test('有失败块时，query 用失败块的 stderr 摘要', () => {
  const q = buildLessonsQuery([mk({ desc: 'A', ok: false, stderr: 'Error: boom at foo.ts' })])
  assert.ok(q.includes('boom'))
})

test('全成功时，query 用 desc 拼接', () => {
  const q = buildLessonsQuery([mk({ desc: '任务甲' }), mk({ desc: '任务乙' })])
  assert.ok(q.includes('任务甲') && q.includes('任务乙'))
})

test('失败块优先于成功块的 desc', () => {
  const q = buildLessonsQuery([mk({ desc: '成功项' }), mk({ ok: false, stderr: 'FATAL-XYZ' })])
  assert.ok(q.includes('FATAL-XYZ'))
  assert.ok(!q.includes('成功项'))
})

test('空输入返回空串', () => {
  assert.equal(buildLessonsQuery([]), '')
})

test('query 上限 2000 字符', () => {
  const q = buildLessonsQuery([mk({ ok: false, stderr: 'x'.repeat(5000) })])
  assert.ok(q.length <= 2000)
})
