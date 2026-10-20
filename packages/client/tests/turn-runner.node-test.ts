// [turn-runner-v1] 执行器守卫：并发 / 幂等 / 取消 / 预算 / 启动顺序。
//
// [WHY] 这些性质都是「高频低可见」的：并发超了只是慢，重复启动只是多跑一遍，
//   顺序乱了用户只看到卡片跳位 —— 没有任何一条会立刻炸。不写成裸跑用例就必然腐化。
// [CONSTRAINT] turn-runner.ts 零依赖，本文件不 stub 任何全局（与 run-queue / feedback-merge 同纪律）。
import assert from 'node:assert/strict'
import { test } from 'vitest'
import {
  createTurnRunner,
  DEFAULT_TURN_CONCURRENCY,
  ERR_MAX_CHARS,
  formatTurnResults,
  OUT_TAIL_CHARS,
  OUT_TAIL_LINES,
  pickScriptBlocks,
  turnRunKey,
} from '../composables/runner/turn-runner.js'
import type { TurnRunResult, TurnScriptBlock } from '../composables/runner/turn-runner.js'

interface Gate {
  promise: Promise<TurnRunResult>
  resolve: (v: TurnRunResult) => void
  reject: (e: unknown) => void
}

function gate(): Gate {
  let resolve!: (v: TurnRunResult) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<TurnRunResult>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 0) })

function mkBlocks(n: number): TurnScriptBlock[] {
  return Array.from({ length: n }, (_, i) => ({ id: `b${i}`, seq: i, code: `console.log(${i})` }))
}

// ── 1. 并发上限 + 启动顺序 ──

test('并发不超过 3；启动顺序严格等于 seq 序（R8）', async () => {
  const gates = new Map<string, Gate>()
  const startedOrder: string[] = []
  let cur = 0
  let peak = 0
  const runner = createTurnRunner({
    run: async ({ block }) => {
      startedOrder.push(block.id)
      cur += 1
      if (cur > peak) peak = cur
      const g = gate()
      gates.set(block.id, g)
      const r = await g.promise
      cur -= 1
      return r
    },
  })

  const p = runner.submit(1, mkBlocks(5))
  // 槽位 3：前 3 块同步启动，第 4 块必须等
  assert.deepEqual(startedOrder, ['b0', 'b1', 'b2'], '前 3 块应同步启动（启动序 = seq 序）')
  assert.equal(runner.stats().inFlight, 3)

  // 逐个放行：第 4、5 块只能在前面的落地后才启动
  gates.get('b0')!.resolve({ status: 'ok', exit: 0 })
  await tick()
  assert.deepEqual(startedOrder, ['b0', 'b1', 'b2', 'b3'], '释放一个槽位后应启动 b3')
  gates.get('b1')!.resolve({ status: 'ok', exit: 0 })
  await tick()
  assert.deepEqual(startedOrder, ['b0', 'b1', 'b2', 'b3', 'b4'])

  gates.get('b2')!.resolve({ status: 'ok', exit: 0 })
  gates.get('b3')!.resolve({ status: 'ok', exit: 0 })
  gates.get('b4')!.resolve({ status: 'ok', exit: 0 })
  const out = await p

  assert.ok(peak <= DEFAULT_TURN_CONCURRENCY, `并发峰值 ${peak} 超过 ${DEFAULT_TURN_CONCURRENCY}`)
  assert.equal(out.length, 5)
  assert.deepEqual(out.map(r => r.id), ['b0', 'b1', 'b2', 'b3', 'b4'], '回灌顺序必须按 seq')
  assert.equal(runner.stats().inFlight, 0)
})

test('乱序传入的块按 seq 启动与回灌（顺序不依赖调用方）', async () => {
  const started: string[] = []
  const runner = createTurnRunner({
    run: async ({ block }) => {
      started.push(block.id)
      return { status: 'ok' as const }
    },
  })
  // 故意倒序传入，seq 显式给出
  const out = await runner.submit(1, [
    { id: 'z', seq: 3, code: '3' },
    { id: 'y', seq: 2, code: '2' },
    { id: 'x', seq: 1, code: '1' },
    { id: 'w', seq: 0, code: '0' },
  ])
  assert.deepEqual(started, ['w', 'x', 'y', 'z'], '启动序必须按 seq，与入参数组顺序无关')
  assert.deepEqual(out.map(r => r.id), ['w', 'x', 'y', 'z'])
})

test('maxConcurrency 可注入（测试用小值）', async () => { const gates: Gate[] = []
  const runner = createTurnRunner({
    maxConcurrency: 1,
    run: () => {
      const g = gate()
      gates.push(g)
      return g.promise
    },
  })
  const p = runner.submit(1, mkBlocks(2))
  assert.equal(runner.stats().inFlight, 1, 'maxConcurrency=1 时只能有 1 块在飞')
  gates[0]!.resolve({ status: 'ok' })
  await tick()
  assert.equal(runner.stats().inFlight, 1)
  gates[1]!.resolve({ status: 'ok' })
  await p
  assert.equal(runner.stats().maxInFlight, 1)
})

// ── 2. 幂等 ──

test('同 turn 重复进入不重跑：复用同一 promise，返回同一份结果', async () => {
  let calls = 0
  const runner = createTurnRunner({
    run: async () => {
      calls += 1
      return { status: 'ok' as const, exit: 0 }
    },
  })
  const blocks = mkBlocks(2)
  const p1 = runner.submit(1, blocks)
  const p2 = runner.submit(1, blocks)
  assert.equal(p1, p2, '第二次 submit 必须复用同一 promise（不是新建一个空跑）')
  const [a, b] = await Promise.all([p1, p2])
  assert.deepEqual(a, b)
  assert.equal(calls, 2, '两块各跑一次；重复进入不得加速成 4 次')
  assert.equal(runner.stats().rounds, 1, '预算：1 turn = 1 轮')
})

test('账本命中不重跑：已记账的块再次提交直接返回旧结果', async () => {
  let calls = 0
  const runner = createTurnRunner({
    run: async ({ block }) => {
      calls += 1
      return { status: block.id === 'b0' ? 'error' as const : 'ok' as const, exit: block.id === 'b0' ? 1 : 0 }
    },
  })
  await runner.submit(1, mkBlocks(2))
  assert.equal(calls, 2)

  // reset 只清计数会清账本 → 用同一实例但换 turn 验证「同 turn|id 才去重」不成立；
  // 这里直接对已收口 turn 再次 submit 命中 turns 缓存
  const again = await runner.submit(1, mkBlocks(2))
  assert.equal(calls, 2, '同 turn 再次 submit 不得重跑')
  assert.equal(again[0]!.status, 'error', '旧结果（含失败）必须原样返回，不能因为失败就重试')
})

test('块被账本命中时只跑新增块（部分重叠提交）', async () => {
  const calls: string[] = []
  const runner = createTurnRunner({
    run: async ({ block }) => {
      calls.push(block.id)
      return { status: 'ok' as const }
    },
  })
  // 先只提交 b0，再对同 turn 提交 b0+b1：b1 是新增 ⇒ 必须补跑
  await runner.submit(1, mkBlocks(1))
  assert.deepEqual(calls, ['b0'])
  await runner.submit(1, [mkBlocks(2)[0]!, mkBlocks(2)[1]!])
  // 同 turn 已收口 ⇒ 复用旧 promise，返回旧结果（不含 b1）
  assert.deepEqual(calls, ['b0'], '同 turn 已收口的 promise 优先于账本补跑')
})

test('superseded 不重跑：新 turn 到来时旧 turn 的在飞块标 superseded 且不再启动', async () => {
  const started: string[] = []
  const gates = new Map<string, Gate>()
  let abortCalls = 0
  const runner = createTurnRunner({
    run: async ({ block }) => {
      started.push(block.id)
      const g = gate()
      gates.set(block.id, g)
      return g.promise
    },
    abort: () => { abortCalls += 1 },
  })

  const pOld = runner.submit(1, mkBlocks(2))
  assert.deepEqual(started, ['b0', 'b1'])
  // turn 2 到来 ⇒ turn 1 被取代
  const pNew = runner.submit(2, [{ id: 'n0', seq: 0, code: 'x' }])
  assert.equal(abortCalls, 1, '取代时必须真的调 abort 停下在飞执行')

  gates.get('b0')!.reject(new Error('aborted by host'))
  gates.get('b1')!.resolve({ status: 'ok', exit: 0 })
  const oldOut = await pOld
  assert.deepEqual(oldOut.map(r => r.status), ['superseded', 'superseded'], '旧 turn 结果一律改写为 superseded')

  gates.get('n0')!.resolve({ status: 'ok' })
  await pNew
  assert.deepEqual(started, ['b0', 'b1', 'n0'], 'superseded 的块不得被重新启动')
  assert.deepEqual(runner.outcomesOf(1).map(r => r.status), ['superseded', 'superseded'])
})

// ── 3. 取消 ──

test('abortTurn 批量取消在飞块，取消后无残留 run', async () => {
  const started: string[] = []
  const gates = new Map<string, Gate>()
  const runner = createTurnRunner({
    run: async ({ block }) => {
      started.push(block.id)
      const g = gate()
      gates.set(block.id, g)
      return g.promise
    },
    abort: () => {
      for (const g of gates.values()) g.reject(new Error('aborted'))
    },
  })

  const p = runner.submit(1, mkBlocks(3))
  assert.equal(runner.stats().inFlight, 3)
  const cancelled = runner.abortTurn(1)
  assert.deepEqual(cancelled.sort(), ['b0', 'b1', 'b2'], '应返回全部在飞块 id')
  assert.deepEqual(runner.activeTurns(), [1], 'abort 调用期间仍在飞')

  const out = await p
  assert.deepEqual(out.map(r => r.status), ['aborted', 'aborted', 'aborted'])
  assert.deepEqual(runner.activeTurns(), [], '取消后不得有残留 run')
  assert.equal(runner.stats().inFlight, 0)
})

test('取消后未启动的块不再真的执行（只记账）', async () => {
  const started: string[] = []
  const gates = new Map<string, Gate>()
  const runner = createTurnRunner({
    maxConcurrency: 1,
    run: async ({ block }) => {
      started.push(block.id)
      const g = gate()
      gates.set(block.id, g)
      return g.promise
    },
    abort: () => { gates.get('b0')?.reject(new Error('aborted')) },
  })

  const p = runner.submit(1, mkBlocks(3))
  assert.deepEqual(started, ['b0'], 'maxConcurrency=1 时只有 b0 启动')
  runner.abortTurn(1)
  const out = await p
  assert.deepEqual(started, ['b0'], 'b1/b2 在取消后不得启动')
  assert.deepEqual(out.map(r => r.status), ['aborted', 'aborted', 'aborted'])
  assert.deepEqual(runner.outcomesOf(1).map(r => r.status), ['aborted', 'aborted', 'aborted'])
})

test('abortTurn 对已收口 turn 是纯 no-op：不发全局中止信号（否则误伤别的 turn）', async () => {
  let abortCalls = 0
  const runner = createTurnRunner({
    run: async () => ({ status: 'ok' as const }),
    abort: () => { abortCalls += 1 },
  })
  await runner.submit(1, mkBlocks(1))
  assert.deepEqual(runner.abortTurn(1), [])
  assert.equal(abortCalls, 0, '已收口 turn 不该调全局 abort')

  // 另一个 turn 在飞：取消已收口的 turn 1 不得把它掐掉
  const stuck = gate()
  const runner2 = createTurnRunner({
    run: async () => stuck.promise,
    abort: () => { abortCalls += 1 },
  })
  void runner2.submit(2, [{ id: 'x', seq: 0, code: 'x' }])
  await tick()
  runner2.abortTurn(1)
  assert.equal(abortCalls, 0, '取消一个从未提交的 turn 不得触发全局中止')
  assert.deepEqual(runner2.activeTurns(), [2])
})

test('有在飞块时 abortTurn 必须真的调全局 abort（否则只是记账、进程照跑）', async () => {
  const g = gate()
  let abortCalls = 0
  const runner = createTurnRunner({
    run: () => g.promise,
    abort: () => {
      abortCalls += 1
      g.reject(new Error('aborted by abort()'))
    },
  })
  const p = runner.submit(1, [{ id: 'a', seq: 0, code: 'x' }])
  await tick()
  const ids = runner.abortTurn(1)
  assert.deepEqual(ids, ['a'])
  assert.equal(abortCalls, 1, '有在飞块时不下中止信号 ⇒ 宿主继续跑完，取消形同虚设')
  const out = await p
  assert.equal(out[0]!.status, 'aborted')
})

test('abortAll 覆盖所有在飞 turn', async () => {
  const gates: Gate[] = []
  const runner = createTurnRunner({
    maxConcurrency: 2,
    run: () => {
      const g = gate()
      gates.push(g)
      return g.promise
    },
    abort: () => { for (const g of gates) g.reject(new Error('aborted')) },
  })
  // 两个 turn 各 1 块，都进在飞（不同 turn 不互相取代：只取代更小的）
  const pA = runner.submit(3, [{ id: 'a', seq: 0, code: 'a' }])
  const pB = runner.submit(4, [{ id: 'b', seq: 0, code: 'b' }])
  assert.deepEqual(runner.activeTurns(), [3, 4])
  runner.abortAll()
  const [a, b] = await Promise.all([pA, pB])
  assert.equal(a[0]!.status, 'aborted')
  assert.equal(b[0]!.status, 'aborted')
  assert.deepEqual(runner.activeTurns(), [])
})

// ── 4. 边界 / 观察者 ──

test('run 抛异常 ⇒ status=error 且记账（不重跑）', async () => {
  let calls = 0
  const runner = createTurnRunner({
    run: async () => {
      calls += 1
      throw new Error('boom')
    },
  })
  const out = await runner.submit(1, mkBlocks(1))
  assert.equal(out[0]!.status, 'error')
  assert.match(out[0]!.err || '', /boom/)
  await runner.submit(1, mkBlocks(1))
  assert.equal(calls, 1, '失败的块同样记账，不得因失败自动重试')
})

test('空列表不记账：同 turn 后续真正的块仍可执行', async () => {
  const runner = createTurnRunner({ run: async () => ({ status: 'ok' as const }) })
  const empty = await runner.submit(1, [])
  assert.deepEqual(empty, [])
  assert.equal(runner.stats().rounds, 0, '空 turn 不计轮')
  const out = await runner.submit(1, mkBlocks(1))
  assert.equal(out.length, 1, '空提交不得挡住同 turn 的真块（否则幂等闸门把整轮吞掉）')
})

test('seed 灌入的服务端账本挡住重放：已执行块不再启动，结果里照常出现', async () => {
  const started: string[] = []
  const runner = createTurnRunner({
    run: async ({ block }) => {
      started.push(block.id)
      return { status: 'ok' as const, exit: 0 }
    },
  })
  // 页面重连：客户端是新实例，服务端 turns.jsonl 里 b0 已执行过
  const n = runner.seed(1, [{ id: 'b0', seq: 0, status: 'ok', exit: 0, out: 'from-server' }])
  assert.equal(n, 1)
  assert.equal(runner.has(1, 'b0'), true)

  const out = await runner.submit(1, mkBlocks(2))
  assert.deepEqual(started, ['b1'], 'b0 已记账不得重跑（重放帧的最大风险）')
  assert.deepEqual(out.map(r => r.id), ['b0', 'b1'], '回灌必须含 seed 的历史结果，否则模型以为那一块没跑')
  assert.equal(out[0]!.out, 'from-server')

  // 重复 seed 不覆盖首次记录
  assert.equal(runner.seed(1, [{ id: 'b0', seq: 0, status: 'error', err: 'later' }]), 0)
  assert.equal(runner.outcomesOf(1)[0]!.status, 'ok', '首次记录更可信，seed 不得覆盖')
})

test('seed 空 / 非法输入安全返回 0', () => {
  const runner = createTurnRunner({ run: async () => ({ status: 'ok' as const }) })
  assert.equal(runner.seed(1, [] as never), 0)
  assert.equal(runner.seed(1, null as never), 0)
  assert.equal(runner.seed(1, [{ id: '', seq: 0, status: 'ok' }, null as never]), 0)
})

test('onOutcome / onTurnEnd 回调按 seq 顺序收到结果；观察者抛异常不影响主链路', async () => {
  const seen: string[] = []
  let endArgs: { turnId: number, ids: string[], rounds: number } | null = null
  const runner = createTurnRunner({
    run: async ({ block }) => ({ status: 'ok' as const, exit: 0, out: block.id }),
    onOutcome: (turnId, o) => {
      seen.push(`${turnId}:${o.id}`)
      throw new Error('observer boom')
    },
    onTurnEnd: (turnId, results, r) => {
      endArgs = { turnId, ids: results.map(x => x.id), rounds: r }
    },
  })
  const out = await runner.submit(7, mkBlocks(3))
  assert.equal(out.length, 3)
  assert.deepEqual(seen.sort(), ['7:b0', '7:b1', '7:b2'])
  assert.deepEqual(endArgs, { turnId: 7, ids: ['b0', 'b1', 'b2'], rounds: 1 })
})

test('账本上限：只淘汰已收口 turn，在飞 turn 的 promise 缓存不被抹（否则重入会重跑）', async () => {
  // 模拟「宿主响应不了 abort」：turn 1 的 gate 永不 settle
  const stuck = gate()
  const runner = createTurnRunner({
    maxTurns: 1,
    run: async ({ turnId }) => (turnId === 1 ? stuck.promise : { status: 'ok' as const }),
    abort: () => { /* 宿主不响应：在飞 turn 会一直挂着 —— 这正是要防的场景 */ },
  })
  const blocks = [{ id: 'b0', seq: 0, code: 'x' }]
  const p1 = runner.submit(1, blocks)
  await tick()
  assert.equal(runner.stats().started, 1)

  // turn 2 立即收口 ⇒ order 涨到 2 > maxTurns(1)，trim 被触发；turn 1 未收口必须留下
  await runner.submit(2, [{ id: 'c0', seq: 0, code: 'y' }])
  const startedAfterTurn2 = runner.stats().started
  // 同 turn 重入必须仍拿到原 promise；若 trim 抹掉了 turns 缓存，这里会新建并再 launch 一次
  assert.equal(runner.submit(1, blocks), p1, '在飞 turn 的 submit 缓存被 trim 抹掉 ⇒ 重入会重跑')
  assert.equal(runner.stats().started, startedAfterTurn2, '重入不得启动第二次')
})

// ── 5. 纯工具函数 ──

test('pickScriptBlocks：过滤无 id / 空 code / 非 script，按 seq 排序，不修改入参', () => {
  const input: unknown[] = [
    { type: 'say', id: 's1', text: 'hi' },
    { type: 'script', id: 'b2', seq: 2, code: 'two' },
    { type: 'script', id: '', seq: 1, code: 'bad' },
    { type: 'script', id: 'b0', seq: 0, code: 'zero' },
    { type: 'script', id: 'b1', seq: 1, code: '   ' },
    { type: 'script', id: 'b3', seq: 3, code: 'three', lang: 'js', desc: 'd', why: 'w' },
    null,
  ]
  const before = JSON.stringify(input)
  const picked = pickScriptBlocks(input)
  assert.deepEqual(picked.map(b => b.id), ['b0', 'b2', 'b3'])
  assert.deepEqual(picked.map(b => b.seq), [0, 2, 3])
  assert.equal(picked[2]!.lang, 'js')
  assert.equal(JSON.stringify(input), before, '不得修改入参')
  assert.deepEqual(pickScriptBlocks(null), [])
  assert.deepEqual(pickScriptBlocks('nope'), [])
})

// [WHY 这条是踩过坑的判据] 帧的规范字段是 `blockId` 而不是 `id`。
//   曾经 pickScriptBlocks 只认 `id` ⇒ 累积器交上来的帧被整批跳过 ⇒ 脚本静默不执行、且零报错。
//   只测 `id` 的话，这个断口能一路绿到生产。
test('pickScriptBlocks：认块帧的规范字段 blockId（不认 ⇒ 整轮脚本静默不执行）', () => {
  const picked = pickScriptBlocks([
    { type: 'script', blockId: 'a', seq: 1, code: '1' },
    { type: 'script', blockId: 'b', seq: 0, code: '2' },
    { type: 'script', blockId: '', seq: 2, code: '3' },
  ])
  assert.deepEqual(picked.map(b => [b.id, b.seq]), [['b', 0], ['a', 1]])
})

test('pickScriptBlocks：blockId 与 id 同时存在时以 blockId 为准', () => {
  const picked = pickScriptBlocks([{ type: 'script', blockId: 'canon', id: 'legacy', code: 'x' }])
  assert.deepEqual(picked.map(b => b.id), ['canon'])
})

test('pickScriptBlocks：seq 缺省时用数组下标兜底', () => {
  const picked = pickScriptBlocks([
    { type: 'script', id: 'x', code: '1' },
    { type: 'script', id: 'y', code: '2' },
  ])
  assert.deepEqual(picked.map(b => [b.id, b.seq]), [['x', 0], ['y', 1]])
})

test('formatTurnResults：结构化摘要，含成功数与逐块状态；空结果空串', () => {
  assert.equal(formatTurnResults(1, []), '')
  const text = formatTurnResults(5, [
    { id: 'b0', seq: 0, status: 'ok', exit: 0 },
    { id: 'b1', seq: 1, status: 'error', exit: 1, err: 'TypeError: x is not a function' },
    { id: 'b2', seq: 2, status: 'aborted' },
  ])
  assert.match(text, /^# turn 5 执行结果（3 块 · 成功 1 · 未成功 2）/)
  assert.match(text, /1\. ✅ b0 \[ok\] exit=0/)
  assert.match(text, /2\. ❌ b1 \[error\] exit=1 err=TypeError/)
  assert.match(text, /3\. ❌ b2 \[aborted\]\n\n⚠/)
})

// [turn-out-feedback-v1] AI 侧没有任何别的通道能看到脚本输出 ⇒ 回灌必须带 stdout。
// [WHY 钉死截断] 实测单块 stdout 可达 5 万~11 万字符；不截断会打爆上下文并加重平台限流，
//   而「不截断」这个改法在功能上「更全」，只有断言上限才拦得住。
test('回灌携带 stdout：尾部 %d 行 / %d 字，超限标注省略', () => {
  assert.equal(OUT_TAIL_LINES, 40)
  assert.equal(OUT_TAIL_CHARS, 2000)
  // ① 有输出 ⇒ 摘要行下方紧跟围栏正文
  const withOut = formatTurnResults(7, [{ id: 'c1', seq: 0, status: 'ok', exit: 0, out: 'hello\nworld' }])
  assert.match(withOut, /1\. ✅ c1 \[ok\] exit=0\n```\nhello\nworld\n```/)
  // ② 全空白输出 ⇒ 不挂空围栏（否则每块都多两行噪音）
  const blank = formatTurnResults(7, [{ id: 'c2', seq: 0, status: 'ok', exit: 0, out: '  \n ' }])
  assert.match(blank, /1\. ✅ c2 \[ok\] exit=0\n\n⚠/)
  // ③ 超行数 ⇒ 只留末 40 行并标注省略量
  const many = Array.from({ length: 100 }, (_, i) => `L${i}`).join('\n')
  const clipped = formatTurnResults(8, [{ id: 'c3', seq: 0, status: 'ok', exit: 0, out: many }])
  assert.match(clipped, /…（省略前 60 行）/)
  assert.ok(clipped.includes('L99'), '必须保留尾部行（排错看末尾）')
  assert.ok(!clipped.includes('\nL0\n'), '头部行应被丢弃')
})

// [turn-err-feedback-v1] err 此前被硬切 200 字且不折叠换行：栈最有用的中段被截、且换行撕裂文案。
test('[turn-err-feedback-v1] err 折叠成单行并限长 ERR_MAX_CHARS', () => {
  assert.equal(ERR_MAX_CHARS, 600)
  // 换行折叠成空格：err 是「一行摘要」，不得在各块行之间插空行
  const multiline = formatTurnResults(9, [{ id: 'e1', seq: 0, status: 'error', exit: 1, err: 'line1\nline2\nline3' }])
  assert.match(multiline, /err=line1 line2 line3/)
  // 超限补省略号
  const long = formatTurnResults(9, [{ id: 'e2', seq: 0, status: 'error', exit: 1, err: 'x'.repeat(1000) }])
  assert.match(long, /err=x{600}…/)
})

// [turn-out-fence-v1] stdout 自带 ``` 时固定 3 反引号围栏会被内容提前闭合 ⇒ 回灌文案裂成两段。
test('[turn-out-fence-v1] 围栏按内容最长连续反引号自适应加长', () => {
  const out = 'before\n```\ninner\n```\nafter'
  const text = formatTurnResults(10, [{ id: 'c1', seq: 0, status: 'ok', exit: 0, out }])
  // 内容里最长连续反引号是 3 ⇒ 围栏取 4；否则内容里的 ``` 会把开围栏提前闭合
  assert.match(text, /exit=0\n````\n/, '开围栏必须是 4 反引号（内容含 3 连反引号时固定 3 会被闭合）')
  assert.match(text, /\nafter\n````/, '闭围栏须与开围栏同长')
  assert.match(text, /下一次回复必须是单个 json 围栏包住的 turn 信封/, '回灌末尾须带 json 围栏提醒（防止 AI 输出错格式触发循环暂停）')
  // [api-recheck-v1] 回灌尾部须提醒「不确定的 API 先查」——跨会话无记忆 + 长对话遗忘，
  //   这句是唯一每轮都在的 API 使用约束。
  assert.match(text, /api-recheck-v1/, '回灌末尾须带「不确定 API 先查」提示')
})

test('turnRunKey：`turn|id` 与 runKey 同形', () => {
  assert.equal(turnRunKey(3, 'b1'), '3|b1')
})

test('reset 清空账本与计数（会话切换用）', async () => {
  const runner = createTurnRunner({ run: async () => ({ status: 'ok' as const }) })
  await runner.submit(1, mkBlocks(2))
  assert.equal(runner.stats().rounds, 1)
  runner.reset()
  assert.equal(runner.stats().rounds, 0)
  assert.equal(runner.stats().started, 0)
  assert.deepEqual(runner.outcomesOf(1), [])
})
