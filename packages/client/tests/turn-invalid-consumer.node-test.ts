// [correction-policy-v1] 承重：useAiReplyHandlers 把 ai-runner:turn-invalid 真正路由到回灌逻辑，
//   且回灌走 copyAndFill(prompt, { skipRules: true })，仅在活跃循环态触发。
// [text-outside-fence-v1] 围栏外文本回收的用户提示由 useAppStartup.dispatchInbound 的 [tm-diag-v1] 块消费
//   （tm-diag 帧在那里即被 return，不会转发 onSessionIdMessage），故提示锚在 dispatchInbound 而非 reply-handlers。
// [WHY] 用源码锚点而不是真跑：useAutoTakeover 是 Vue 单例，节点测试难以翻转 loopActive，
//   而「是否接线 + 是否走正确出站口 + 是否门控」才是本改动的承重判据。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
function src(): string {
  return readFileSync(join(HERE, '../composables/ai/useAiReplyHandlers.ts'), 'utf8')
}
function startupSrc(): string {
  return readFileSync(join(HERE, '../composables/ui/useAppStartup.ts'), 'utf8')
}

test('承重：onSessionIdMessage 路由 ai-runner:turn-invalid 到回灌处理函数', () => {
  const s = src()
  assert.ok(s.includes('ai-runner:turn-invalid'), 'onSessionIdMessage 未路由 turn-invalid')
  assert.ok(/handleTurnInvalidMsg\s*\(\s*payload\s*,\s*e\s*\)/.test(s), 'turn-invalid 未调用 handleTurnInvalidMsg')
})

test('承重：回灌走 copyAndFill(prompt, { skipRules: true })（与 feedbackMerge 出站口一致，不重注入 SYSTEM.md）', () => {
  const s = src()
  assert.ok(/copyAndFill\(\s*decision\.prompt\s*,\s*\{\s*skipRules:\s*true\s*\}\s*\)/.test(s), '回灌未用 copyAndFill + skipRules:true')
})

test('承重：回灌仅在活跃循环态触发（loopActive = autoTakeover.enabled.value）', () => {
  const s = src()
  assert.ok(/loopActive:\s*autoTakeover\.enabled\.value/.test(s), 'decideCorrection 未传入 loopActive = autoTakeover.enabled.value')
})

test('承重：useAiReplyHandlers 显式 import decideCorrection（纯策略模块，便于裸测）', () => {
  const s = src()
  assert.ok(/import\s*\{\s*decideCorrection[^}]*\}\s*from\s*'(?:\.\.\/)*utils\/correction-policy'/.test(s), '未显式 import decideCorrection 自 correction-policy')
})

test('承重：围栏外文本回收的用户提示锚在 dispatchInbound 的 tm-diag 块（text-outside-fence → pushTerminalNotice）', () => {
  const s = startupSrc()
  assert.ok(/t === 'ai-runner:tm-diag'/.test(s), 'dispatchInbound 未处理 tm-diag')
  assert.ok(s.includes('text-outside-fence'), 'dispatchInbound 未识别 text-outside-fence 阶段')
  assert.ok(/pushTerminalNotice\(/.test(s), 'text-outside-fence 未给用户可见提示')
})

test('承重：useAiReplyHandlers 不得再路由 tm-diag（那是不可达死代码，防回归）', () => {
  const s = src()
  assert.ok(!/handleTmDiagMsg/.test(s), 'handleTmDiagMsg 仍在 reply-handlers：tm-diag 在 dispatchInbound 即被消费，此处是死代码')
  assert.ok(!/ai-runner:tm-diag/.test(s), 'onSessionIdMessage 仍路由 tm-diag：死代码回归')
})

test('承重：合法 turn 收口会清零同 sid 连续纠正计数（「连续」语义）', () => {
  const s = src()
  // handleTurnEndMsg 内应删除 correctionCountBySid 中该 sid 的计数
  assert.ok(/correctionCountBySid\.delete\(\s*sid\s*\)/.test(s), '收到合法 turn 收口未清零连续纠正计数')
})
