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
import { collectAwaiting, createTurnCollector, supportsBlock } from '../composables/runner/turn-collect.js'
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

/**
 * [body-slice-v1] 按**花括号配平**切出函数体，而不是按固定字符窗口。
 *
 * [WHY] 固定窗口（`slice(at, at + 1200)`）把「函数体有多大」和「判据在不在里面」
 *   焊在了一起：函数里多插一段无关代码（本次是插入回程诊断帧的 toast 分支），
 *   真实存在的接线就会被窗口截断而报红—— 守卫于是变成了「不许改这个函数」的锁，
 *   逼着人把诊断代码删掉，或者去调大魔法数字。
 *   按配平切则与长度无关：判据只要在这个函数里就一定看得到。
 *
 * [CONSTRAINT] 朴素配对（与仓库既有做法一致）：不解析字符串/模板字面量。
 *   代价是函数体里的字符串中若含不成对的 `{` 会提前截断—— 那种情况会表现为
 *   「断言找不到」，而不是假绿，仍能被 review 看见。
 * [CONSTRAINT] 从**函数体的开括号**起配平，且该开括号必须**在参数列表的右括号之后**：
 *   TS 签名可以带对象类型的花括号（`f(p: { end?: X })`），它自身开合并平衡，
 *   若从它起算会在签名结束处depth 归零、只切出一个空壳。
 *   做法：先找`)` 的匹配终点，再往后找第一个 `{`。
 */
function bodyOf(src: string, fnStart: string): string {
  const at = src.indexOf(fnStart)
  assert.ok(at > 0, `缺 ${fnStart}`)
  // 参数列表：从 fnStart 后第一个 '(' 起做配平（签名里可能有嵌套括号）
  const parenAt = src.indexOf('(', at)
  assert.ok(parenAt > 0, `${fnStart} 缺参数列表`)
  let pd = 0
  let bodyOpen = -1
  for (let i = parenAt; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') { pd += 1
    }
    else if (ch === ')') {
      pd -= 1
      if (pd === 0) { bodyOpen = src.indexOf('{', i); break }
    }
  }
  if (bodyOpen < 0) return src.slice(at)
  let depth = 0
  for (let i = bodyOpen; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') { depth += 1
    }
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  return src.slice(at)
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
  const body = bodyOf(src, 'function dispatchInbound')
  assert.match(body, /t === 'ai-runner:block' && supportsBlock\(/, '块未过握手闸门 ⇒ 能力清单形同虚设')
  assert.match(body, /turnCollector\.add\(p\.block\)/, '块未进入累积器：渲染有、执行无')
  assert.match(body, /onSessionIdMessage\(e\)/, '喂完累积器必须继续走分发器，否则不渲染')
  // [WHY 连 App.vue 一起断言] 归组挂在 dispatchInbound 上，若 window 通道仍注册裸 handler ⇒ 漏喂
  assert.match(readSrc('packages/client/App.vue'), /useEventListener\(window, 'message', dispatchInbound\)/, 'window 通道未走收口点')
})

test('wiring: 回放帧（replayed）只丢弃桶、不触发执行', () => {
  const src = readSrc('packages/client/composables/ui/useAppStartup.ts')
  const body = bodyOf(src, 'function dispatchInbound')
  assert.match(body, /replayed === true\)[\s\S]{0,60}turnCollector\.drop\(/, '缺 replayed 闸门：回放帧会驱动执行')
  // [runtime-kind-ssot-v1] 非回放帧收口改经 settleTurnEnd：它同时负责「无 script 块 ⇒ 运行态归 idle」。
  //   [body-slice-v1] 路由断言属于 dispatchInbound；「真的调 end()」属于 settleTurnEnd 自己的函数体——
  //   原断言把两者都放在 dispatchInbound 的固定窗口里，靠窗口溢出到下一个函数才够得着，
  //   那是在断言一个不属于该函数的实现细节（函数一挪位就假红）。按职责分到各自函数里。
  assert.match(body, /turn-end'\)[\s\S]{0,20}settleTurnEnd\(/, '非回放帧必须收口，否则脚本永不执行')
  const settle = bodyOf(src, 'function settleTurnEnd')
  assert.match(settle, /turnCollector\.end\(p\.end\)/, '收口必须真的调 end()：否则桶不清、下一轮拿到旧块重跑')
  // settleTurnEnd 的第二职责：没有 script 块时把运行态归位，否则等待 banner 永不消失
  assert.match(settle, /!hasScript\) rt\.settleIdle\(\)/, '无 script 块的 turn 必须归位运行态，否则永久停在「思考中」')
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

// ── 能力握手（P4-c）──
//
// [WHY 三态而不是布尔] 油猴通道**根本没有 hello 帧**。若把「没收到 hello」
// 解释成「不支持信封」，会把正常的油猴回包整轮拦掉 —— 那正是本方案最怕的
// 「功能静默消失」，而且不会有任何报错。

test('supportsBlock：未握手（null / undefined / 空）一律放行', () => {
  assert.equal(supportsBlock(null, 'script'), true, 'null ⇒ 放行（油猴通道）')
  assert.equal(supportsBlock(undefined, 'script'), true, 'undefined ⇒ 放行')
  assert.equal(supportsBlock([], 'script'), true, '空清单 ⇒ 放行（旧服务端不发块帧）')
})

test('supportsBlock：已握手时按清单判定（缺哪种就拦哪种）', () => {
  assert.equal(supportsBlock(['say', 'script'], 'script'), true)
  assert.equal(supportsBlock(['say', 'script'], 'ask'), false, '清单不含 ask ⇒ 该块对端不认，留着只会被静默丢弃')
  assert.equal(supportsBlock(['say', 'script'], 'handoff'), false)
})

test('supportsBlock：type 缺失时不拦（未知块不该被本地丢弃，交给服务端记账）', () => {
  assert.equal(supportsBlock(['say'], ''), true)
})

test('wiring: 服务端 hello 帧必须携带 caps（握手判定的唯一源）', () => {
  const src = readSrc('packages/core/src/server/attach-ws.ts')
  // [WHY 连值一起断言] 只匹配 `caps` 会被「发了但内容是别的」骗过去；
  //   这里锁死必须引用 protocol.ts 的 AI_CAPS 常量，避免清单在两处漂移。
  assert.match(src, /t: 'hello'.*caps: AI_CAPS/, 'hello 未带 AI_CAPS ⇒ 客户端无从判断对端是否支持信封')
  assert.match(src, /import \{ AI_CAPS \} from '\.\/protocol\.js'/, 'AI_CAPS 未从 protocol 引入 ⇒ 清单有第二份源')
})

test('wiring: 客户端 transport 暴露 caps()，且油猴通道返回 null（未握手 ⇒ 放行）', () => {
  const src = readSrc('packages/client/composables/ai/useAiTransport.ts')
  assert.match(src, /caps: \(\) => readonly string\[\] \| null/, '接口缺 caps() ⇒ 握手判定无处落地')
  const tmpl = readSrc('packages/client/composables/ui/useAppStartup.ts')
  assert.match(tmpl, /supportsBlock\(/, '收口点未调用 supportsBlock ⇒ 握手清单形同虚设')
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
  const sinkBody = src.slice(sinkAt, sinkAt + 1400)
  assert.match(sinkBody, /copyAndFill\(text, \{ skipRules: true \}\)/, '回灌回调必须是真的发送（skipRules 与 feedbackMerge 出站口一致）')
  // [turn-feedback-delay-v1] 出站前必须先静默 TURN_FEEDBACK_DELAY_MS，否则连续轮次回传把频率打到平台限流。
  // [CONSTRAINT] 断言的是「先等后发」的顺序 —— 只断言两者都存在会被「先发再等」的实现骗过去。
  assert.match(
    sinkBody,
    /await promiseTimeout\(TURN_FEEDBACK_DELAY_MS\)[\s\S]*?await copyAndFill\(text, \{ skipRules: true \}\)/,
    '回传前必须等待 TURN_FEEDBACK_DELAY_MS（脚本跑完 → 出站之间）',
  )
  // [turn-feedback-epoch-v1] 静默窗是异步悬挂的 ⇒ 窗口结束后必须复检会话是否仍有效，
  //   否则切工作区 / 点停止后回传会投进别处（用户实测切工作区后回传串到别处）。
  assert.match(sinkBody, /ctx\.stillValid\(\)/, '静默窗后未复检会话有效性：悬挂回传会投进新会话')
  // [turn-feedback-result-v1] 投递结果必须回流（否则 submitTurn 无法在失败时回滚去重位）。
  assert.match(sinkBody, /return r/, '回灌回调必须返回投递结果，否则失败无法回流')
})

test('turn-feedback-delay-v1：静默窗常量 = 3000ms（改值必须同步本断言）', () => {
  const src = readSrc('packages/client/composables/runner/useTurnRunner.ts')
  assert.match(src, /export const TURN_FEEDBACK_DELAY_MS = 3000/, '静默窗常量被改动或删除')
})
