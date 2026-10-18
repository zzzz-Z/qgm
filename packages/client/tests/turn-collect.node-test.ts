// [turn-collect-v1] 块帧累积器守卫。
//
// [WHY] 累积器是「块 → 执行」之间唯一的有状态环节，出错方式全是静默的：
//   少收一块 ⇒ 少跑一个脚本；turn 串桶 ⇒ 跑到别的轮次；结束帧漏清桶 ⇒ 下一轮拿到旧块重跑。
//   这些都不会抛异常，只会让「AI 说要做三件事，实际做了两件」——必须逐条钉死。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { test } from 'vitest'
import { collectAwaiting, createTurnCollector } from '../composables/runner/turn-collect.js'
import type { CollectBlock } from '../composables/runner/turn-collect.js'

function blk(turnId: number, blockId: string, seq: number, type = 'script'): CollectBlock {
  return { turnId, blockId, seq, type, code: `// ${blockId}` }
}

test('按 turn 分桶、按 seq 排序后一次性提交', () => {
  const got: { turnId: number, ids: string[] }[] = []
  const c = createTurnCollector({ onSubmit: (t, blocks) => { got.push({ turnId: t, ids: blocks.map(b => String(b.blockId)) }) } })
  // 故意乱序到达
  c.add(blk(7, 'b2', 2))
  c.add(blk(7, 'b0', 0))
  c.add({ turnId: 7, blockId: 's1', seq: 1, type: 'say', text: 'hi' })
  assert.deepEqual(c.openTurns(), [7])
  c.end({ turnId: 7, awaiting: 'results', blocks: 3 })
  assert.deepEqual(got, [{ turnId: 7, ids: ['b0', 's1', 'b2'] }])
  assert.deepEqual(c.openTurns(), [], '收口后桶必须清空（否则下一轮会拿到旧块重跑）')
})

test('两个 turn 交错到达互不污染', () => {
  const got: { turnId: number, ids: string[] }[] = []
  const c = createTurnCollector({ onSubmit: (t, blocks) => { got.push({ turnId: t, ids: blocks.map(b => String(b.blockId)) }) } })
  c.add(blk(1, 'a1', 0))
  c.add(blk(2, 'b1', 0))
  c.add(blk(1, 'a2', 1))
  c.end({ turnId: 1 })
  c.end({ turnId: 2 })
  assert.deepEqual(got, [{ turnId: 1, ids: ['a1', 'a2'] }, { turnId: 2, ids: ['b1'] }])
})

test('同 turn 同 blockId 后到覆盖先到（R2：模型改主意）', () => {
  const got: CollectBlock[][] = []
  const c = createTurnCollector({ onSubmit: (_t, blocks) => { got.push(blocks) } })
  c.add({ ...blk(3, 'x', 0), code: 'v1' })
  c.add({ ...blk(3, 'x', 0), code: 'v2' })
  c.end({ turnId: 3 })
  assert.equal(got.length, 1)
  assert.equal(got[0]!.length, 1, '同 id 不得变成两块')
  assert.equal(got[0]![0]!.code, 'v2')
})

test('没有 script 块 ⇒ 不提交（总结轮 / 纯提问轮）', () => {
  const got: number[] = []
  const c = createTurnCollector({ onSubmit: (t) => { got.push(t) } })
  c.add({ turnId: 4, blockId: 's1', seq: 0, type: 'say', text: '做完了' })
  c.end({ turnId: 4, awaiting: 'none', blocks: 1 })
  assert.deepEqual(got, [])
  assert.deepEqual(c.openTurns(), [], '即使不提交也要清桶')

  c.add({ turnId: 5, blockId: 'q1', seq: 0, type: 'ask', question: '选一个' })
  c.end({ turnId: 5, awaiting: 'user', blocks: 1 })
  assert.deepEqual(got, [], 'ask 轮由用户回答驱动，不触发执行')
})

test('以块的真值判定 awaiting，不信 end.awaiting（帧可能被中间层改写）', () => {
  const got: number[] = []
  const c = createTurnCollector({ onSubmit: (t) => { got.push(t) } })
  c.add(blk(6, 'c1', 0))
  // 结束帧谎称 no-need —— 本地有 script 块就必须执行
  c.end({ turnId: 6, awaiting: 'none', blocks: 1 })
  assert.deepEqual(got, [6])
})

test('坏帧被忽略：缺 blockId / 缺 turnId / null 都不污染列表', () => {
  const got: CollectBlock[][] = []
  const c = createTurnCollector({ onSubmit: (_t, blocks) => { got.push(blocks) } })
  c.add(null)
  c.add(undefined)
  c.add({ turnId: 8, seq: 0, type: 'script' } as CollectBlock)
  c.add({ blockId: 'x', seq: 0, type: 'script' } as CollectBlock)
  c.add(blk(8, 'ok', 1))
  c.end({ turnId: 8 })
  assert.deepEqual(got.map(b => b.map(x => x.blockId)), [['ok']])
})

test('结束帧先到（块还没到）⇒ 不提交，桶空', () => {
  const got: number[] = []
  const c = createTurnCollector({ onSubmit: (t) => { got.push(t) } })
  c.end({ turnId: 9, awaiting: 'results', blocks: 2 })
  assert.deepEqual(got, [])
  assert.deepEqual(c.openTurns(), [])
})

test('重复结束帧幂等：第二次无块可交，不会重复执行', () => {
  const got: number[] = []
  const c = createTurnCollector({ onSubmit: (t) => { got.push(t) } })
  c.add(blk(10, 'a', 0))
  c.end({ turnId: 10 })
  c.end({ turnId: 10 })
  assert.deepEqual(got, [10])
})

test('maxTurns 上限：漏收结束帧也不会无界累积，淘汰最旧', () => {
  const c = createTurnCollector({ maxTurns: 2 })
  c.add(blk(1, 'a', 0))
  c.add(blk(2, 'b', 0))
  c.add(blk(3, 'c', 0))
  assert.deepEqual(c.openTurns(), [2, 3], 'turn 1 应被淘汰')
  assert.deepEqual(c.pending(1), [])
  assert.equal(c.pending(3).length, 1, '新进的不受影响')
})

test('drop / reset', () => {
  const got: number[] = []
  const c = createTurnCollector({ onSubmit: (t) => { got.push(t) } })
  c.add(blk(11, 'a', 0))
  c.drop(11)
  c.end({ turnId: 11 })
  assert.deepEqual(got, [], 'drop 后不得提交')

  c.add(blk(12, 'b', 0))
  c.reset()
  c.end({ turnId: 12 })
  assert.deepEqual(got, [])
  assert.deepEqual(c.openTurns(), [])
})

test('collectAwaiting：script > ask > none', () => {
  assert.equal(collectAwaiting([]), 'none')
  assert.equal(collectAwaiting([{ type: 'say' }]), 'none')
  assert.equal(collectAwaiting([{ type: 'ask' }, { type: 'say' }]), 'user')
  assert.equal(collectAwaiting([{ type: 'ask' }, { type: 'script' }]), 'results')
})

test('setOnSubmit 运行时注入（消费方不必为了拿执行器而 import 整条 useRunner 链）', () => {
  const got: number[] = []
  const c = createTurnCollector()
  c.add(blk(14, 'a', 0))
  c.end({ turnId: 14 })
  // [assert-narrowing-v1] 不能写 deepEqual(got, [])：node:assert 的 deepEqual 带
  //   `asserts actual is T` 签名，会在这里把 got 收窄成 never[]，后续 got.push(t) 直接类型错。
  assert.equal(got.length, 0, '未注入时只清桶、不提交')
  c.add(blk(15, 'b', 0))
  c.setOnSubmit((t) => { got.push(t) })
  c.end({ turnId: 15 })
  assert.deepEqual(got, [15])
  c.setOnSubmit(null)
  c.add(blk(16, 'c', 0))
  c.end({ turnId: 16 })
  assert.deepEqual(got, [15], '置 null 后不再提交')
})

test('onSubmit 抛异常不影响桶清空（否则该 turn 永远挂着）', () => {
  const c = createTurnCollector({ onSubmit: () => { throw new Error('boom') } })
  c.add(blk(13, 'a', 0))
  c.end({ turnId: 13 })
  assert.deepEqual(c.openTurns(), [])
})

// ── 接线守卫（源码锚点）──
//
// [WHY 用锚点而不是真跑] `useAiReplyHandlers` 依赖 6 个模块级单例（runner / inbox / takeover /
//   site / waiting / window），真跑要造一整套宿主；而这里要钉死的只有三件事：
//   路由存在、块真的喂给累积器、回放帧不触发执行。行为逻辑本身已由上面的累积器用例覆盖。

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

test('wiring: ai-runner:turn-end 必须路由到 handleTurnEndMsg（否则油猴/无头的结束帧无人消费）', () => {
  const src = readSrc('packages/client/composables/ai/useAiReplyHandlers.ts')
  assert.match(src, /if \(t === 'ai-runner:turn-end'\) return handleTurnEndMsg\(payload, e\)/, '结束帧未接线：累积器永远收不到口')
})

// [WHY 归组挂在 useAppStartup 的 dispatchInbound 而不是 handleBlockMsg] 块帧有两条来源：
//   油猴走 window.postMessage（App.vue 直接进分发器）、无头走 WS（startup 包假事件转发）。
//   挂在某个 handler 内部 ⇒ 只能覆盖其中一条；挂在分发器**入参处**才两条都覆盖。
test('wiring: dispatchInbound 收到块帧必须喂给累积器（否则帧渲染了但脚本永不执行）', () => {
  const src = readSrc('packages/client/composables/ui/useAppStartup.ts')
  const at = src.indexOf('function dispatchInbound')
  assert.ok(at > 0, '缺 dispatchInbound：块帧没有统一收口点')
  const body = src.slice(at, at + 900)
  assert.match(body, /t === 'ai-runner:block'\) turnCollector\.add\(/, '块未进入累积器：渲染有、执行无')
  assert.match(body, /onSessionIdMessage\(e\)/, '喂完累积器必须继续走分发器，否则不渲染')
  // [WHY 连 App.vue 一起断言] 归组挂在 dispatchInbound 上，若 window 通道仍注册裸 handler ⇒ 漏喂
  assert.match(readSrc('packages/client/App.vue'), /useEventListener\(window, 'message', dispatchInbound\)/, 'window 通道未走收口点')
})

test('wiring: 回放帧（replayed）只丢弃桶、不触发执行', () => {
  const src = readSrc('packages/client/composables/ui/useAppStartup.ts')
  const at = src.indexOf('function dispatchInbound')
  assert.ok(at > 0, '缺 dispatchInbound')
  const body = src.slice(at, at + 900)
  assert.match(body, /replayed === true\) turnCollector\.drop\(/, '缺 replayed 闸门：回放帧会驱动执行')
  assert.match(body, /turn-end'\) turnCollector\.end\(/, '非回放帧必须收口，否则脚本永不执行')
})

// [WHY 这条锚点是本轮真正要闭合的缺口] 油猴 P3 已开始发 `ai-runner:block` / `turn-end`，
//   但注册进 window 的若是裸分发器 ⇒ 块只渲染、累积器空桶 ⇒ 收口时 `blocks.length === 0` 直接 return。
//   这种断裂**不产生任何错误**：时间线照常出卡片，只有「脚本没跑」这一个可见后果。
test('wiring: App.vue 注册 window message 必须用 dispatchInbound 而非裸 onSessionIdMessage', () => {
  const src = readSrc('packages/client/App.vue')
  assert.match(src, /useEventListener\(window, 'message', dispatchInbound\)/, 'window 通道未走收口点：油猴块帧不进累积器')
  assert.ok(!/useEventListener\(window, 'message', onSessionIdMessage\)/.test(src), '裸分发器仍在注册：两条通道会分裂成两本账')
})

test('wiring: useAppStartup 必须导出 dispatchInbound', () => {
  const src = readSrc('packages/client/composables/ui/useAppStartup.ts')
  assert.match(src, /migrateLastVisit, dispatchInbound \}/, '未导出 dispatchInbound：调用方无从拿到收口点')
})

test('wiring: useAppStartup 订阅 transport.onTurnEnd 且 replayed 透传进假事件', () => {
  const src = readSrc('packages/client/composables/ui/useAppStartup.ts')
  assert.match(src, /transport\.onTurnEnd\?\.\(/, '未订阅结束帧：WS 侧 turn-end 永远到不了分发器')
  assert.match(src, /replayed: replayed === true/, 'replayed 未透传：回放会被当成实时帧触发执行')
  assert.match(src, /turnCollector\.setOnSubmit\(/, '累积器未接执行器：收口后什么都不发生')
  // [WHY 连回调体一起断言] 只匹配 `setTurnFillSink(` 会被「注册了空回调」骗过去 ——
  //   注册只是一个引用赋值，真正的接线是回调里那次发送。
  const sinkAt = src.indexOf('setTurnFillSink(')
  assert.ok(sinkAt > 0, '未注册回灌通道：执行完 AI 收不到结果，循环断在这里')
  assert.match(src.slice(sinkAt, sinkAt + 200), /copyAndFill\(text, \{ skipRules: true \}\)/, '回灌回调必须是真的发送（skipRules 与 feedbackMerge 出站口一致）')
})
