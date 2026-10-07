// [auto-feedback-merge-v1] 守卫：非循环自动回传合并窗的两件事 ——
//   ① 机制成立：多条结果在静默窗内合成一次出站、文案带统计头部、单条逐字等价；
//   ② 接线承重：exec-flow 的 copyOutput 必须真的入窗（不允许绕过合并窗直接 copyAndFill）。
// [WHY] 只测机制不测调用点是真空形态：exec-flow 若退回逐条出站，机制测试照样绿。
//   故段二用源码锚点断言出站唯一（copyAndFill 只允许出现在 flush 回调内），删 stage 即红。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'vitest'
import { AUTO_FEEDBACK_MERGE_MS, buildMergedFeedbackText, createFeedbackMerge } from '../composables/runner/feedback-merge'
import type { FeedbackItem } from '../composables/runner/feedback-merge'

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

function item(text: string, ok = true, exit = 0): FeedbackItem {
  return { text, ok, exit, changes: ok ? [] : [{ path: 'a.ts', type: 'edit' }] }
}

test('单条：mergedText 逐字等于原文（回归红线）', () => {
  const t = '# 脚本执行结果\n状态: ✅ 成功'
  assert.equal(buildMergedFeedbackText([item(t)]), t)
})

test('多条：头部统计 + 每条独立小节 + 原文完整保留', () => {
  const merged = buildMergedFeedbackText([
    item('结果甲'),
    item('结果乙', false, 400),
    item('结果丙'),
  ])
  assert.ok(merged.includes('本批共 3 次执行结果（成功 2 · 失败 1）'), `缺统计头部：${merged}`)
  assert.ok(merged.includes('── 结果 1/3 ──\n结果甲'))
  assert.ok(merged.includes('── 结果 2/3 ──\n结果乙'))
  assert.ok(merged.includes('── 结果 3/3 ──\n结果丙'))
  assert.ok(merged.indexOf('结果甲') < merged.indexOf('结果乙') && merged.indexOf('结果乙') < merged.indexOf('结果丙'), '小节顺序错乱')
})

test('合并窗：窗内 3 条 stage ⇒ 恰 1 次 flush，且是合并文案', async () => {
  const flushed: Array<{ n: number, text: string }> = []
  const m = createFeedbackMerge((items, text) => flushed.push({ n: items.length, text }), { delayMs: 40 })
  m.stage(item('a'))
  await sleep(10)
  m.stage(item('b', false, 400))
  await sleep(10)
  m.stage(item('c'))
  assert.equal(m.pendingCount(), 3, '未到点不应出站')
  await sleep(80)
  assert.equal(flushed.length, 1, `应合并成 1 次出站，实际 ${flushed.length}`)
  assert.equal(flushed[0]!.n, 3)
  assert.ok(flushed[0]!.text.includes('本批共 3 次'))
})

test('窗口顺延：每条 stage 重置静默窗（判据与观测同构，非瞬时快照）', async () => {
  const flushed: number[] = []
  const m = createFeedbackMerge(items => flushed.push(items.length), { delayMs: 50 })
  m.stage(item('a'))
  await sleep(30)
  m.stage(item('b'))
  await sleep(30)
  m.stage(item('c'))
  await sleep(90)
  assert.equal(flushed.length, 1, `逐条顺延下应合 1 次，实际 ${flushed.length}`)
  assert.equal(flushed[0], 3)
})

test('跨批：间隔超过 Δ ⇒ 各自出站，第二条不含第一条内容', async () => {
  const texts: string[] = []
  const m = createFeedbackMerge((_items, text) => texts.push(text), { delayMs: 30 })
  m.stage(item('第一批'))
  await sleep(70)
  m.stage(item('第二批'))
  await sleep(70)
  assert.equal(texts.length, 2, `应分两次出站，实际 ${texts.length}`)
  assert.ok(texts[0]!.includes('第一批') && !texts[0]!.includes('第二批'))
  assert.ok(texts[1]!.includes('第二批') && !texts[1]!.includes('第一批'))
})

test('isActive 拒绝 ⇒ 到点丢弃、不重排、不出站（循环接管语义）', async () => {
  const flushed: number[] = []
  const m = createFeedbackMerge(items => flushed.push(items.length), { delayMs: 20, isActive: () => false })
  m.stage(item('a'))
  await sleep(60)
  assert.equal(flushed.length, 0, '守卫拒绝不得出站')
  assert.equal(m.pendingCount(), 0, '拒绝即丢弃，不得残留重排')
})

test('flush 同步抛错不上抛；async flush 的拒绝不变成 unhandled', async () => {
  const m1 = createFeedbackMerge(() => { throw new Error('boom-sync') }, { delayMs: 10 })
  m1.stage(item('a'))
  await sleep(40) // 不抛即通过
  const m2 = createFeedbackMerge(() => Promise.reject(new Error('boom-async')), { delayMs: 10 })
  m2.stage(item('b'))
  await sleep(40) // 不产生 unhandled rejection 即通过
})

test('cancel：撤窗后不出站、缓冲清空', async () => {
  const flushed: number[] = []
  const m = createFeedbackMerge(items => flushed.push(items.length), { delayMs: 20 })
  m.stage(item('a'))
  m.cancel()
  await sleep(50)
  assert.equal(flushed.length, 0)
  assert.equal(m.pendingCount(), 0)
})

test('delayMs 缺省 = AUTO_FEEDBACK_MERGE_MS（锚点一致性）', () => {
  assert.equal(AUTO_FEEDBACK_MERGE_MS, 3000)
})

// ===== 段二：接线承重（源码锚点）=====

const EXEC_FLOW_SRC = new URL('../components/script/exec-flow.ts', import.meta.url).pathname
function readSrc(): string { return readFileSync(EXEC_FLOW_SRC, 'utf8') }

test('承重：copyOutput 必须经 feedbackMerge.stage 入窗，出站口唯一', () => {
  const src = readSrc()
  const count = (re: RegExp) => (src.match(re) || []).length
  assert.equal(count(/feedbackMerge\.stage\(/g), 1, 'copyOutput 未入合并窗（stage 调用点缺失或被复制）')
  assert.equal(count(/copyAndFill\(/g), 1, `copyAndFill 应只出现在合并窗 flush 回调内（实际 ${count(/copyAndFill\(/g)} 处）——存在绕过合并窗的直发路径`)
  // stage 必须发生在 buildAiPrompt 构造之后（同一函数体内、其后出现）
  const copyOutputBody = src.match(/async function copyOutput[\s\S]*?\n {2}\}/)
  assert.ok(copyOutputBody, '找不到 copyOutput 函数体')
  assert.ok(copyOutputBody[0].includes('await buildAiPrompt()'), 'copyOutput 未构造 prompt')
  assert.ok(copyOutputBody[0].includes('feedbackMerge.stage('), 'copyOutput 构造 prompt 后未入窗')
})

test('承重：ScriptPanel 卸载必须撤窗', () => {
  const src = readFileSync(new URL('../components/script/ScriptPanel.vue', import.meta.url).pathname, 'utf8')
  assert.ok(src.includes('feedbackMerge.cancel()'), 'ScriptPanel onBeforeUnmount 未撤合并窗')
})
