// [p3-4-fingerprint-visible-v1] appendFingerprints 守卫：AST 指纹必须真能渲染进回填 prompt。
// [test-skip-reason-v1] appendFeedbackSummary 守卫：「没跑单测」不得被显示成「通过」。
// 纯函数、无 DOM / 无网络依赖，适合在 node 环境直接锁定行为。
import { it } from 'vitest'
import assert from 'node:assert/strict'
import { appendFeedbackSummary, appendFingerprints } from '../components/script/prompt-builder.js'

it('appendFingerprints：无指纹 / 空数组时不产出任何块', () => {
  const cases: Array<Parameters<typeof appendFingerprints>[1]> = [
    null,
    { ok: false, code: 1 },
    { ok: false, code: 1, fingerprints: [] },
  ]
  for (const r of cases) {
    const p: string[] = []
    appendFingerprints(p, r)
    assert.equal(p.length, 0)
  }
})

it('appendFingerprints：有指纹时产出「文件 | 行 | 符号 | 类别」', () => {
  const p: string[] = []
  appendFingerprints(p, {
    ok: false,
    code: 1,
    fingerprints: [
      { file: 'packages/client/composables/ai/loopLogic.ts', line: 17, symbol: 'LOOP_HARD_MAX_ROUNDS', kind: 'variable' },
    ],
  })
  const text = p.join('\n')
  assert.match(text, /# 失败定位（AST 指纹）/)
  assert.match(text, /packages\/client\/composables\/ai\/loopLogic\.ts \| 17 \| `LOOP_HARD_MAX_ROUNDS` \| variable/)
})

it('appendFeedbackSummary：无测试目标时显式说明「未运行」，且不得出现 test ✓', () => {
  const p: string[] = []
  appendFeedbackSummary(p, {
    ok: true,
    code: 0,
    test: { ran: false, ok: true, reason: 'no-test-targets' },
  })
  const text = p.join('\n')
  assert.match(text, /本轮未运行单测（无测试目标）/)
  assert.doesNotMatch(text, /test ✓/)
})

it('appendFeedbackSummary：真正跑过并通过时才出现 test ✓', () => {
  const p: string[] = []
  appendFeedbackSummary(p, { ok: true, code: 0, test: { ran: true, ok: true } })
  const text = p.join('\n')
  assert.match(text, /test ✓/)
  assert.doesNotMatch(text, /本轮未运行单测/)
})
