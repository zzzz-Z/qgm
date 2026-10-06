// [control-log-v1] 守卫：控制面留痕的值级正确性 + 接线到位。
//
// 背景：`/run` 的前置拒收与 `/tasks` 的写请求此前在服务端**零留痕**，而它们恰是两个最高频
// 用户可见故障的唯一现场（「脚本频繁被截断」/「任务状态不更新」）。本守卫做两件事：
//   ① 对两个纯构造函数做值级断言（字段漏了 / 单行化坏了 / 计数算错了都会红）；
//   ② 断言接线：三个 400 分支各自的留痕**在响应之前**、看板写路径确实调了留痕
//      —— 只测「函数存在」不测「调用点」是典型的真空判据（冻结在没人走的分支上）。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { boardKeysOf, buildBoardEntry, buildRejectEntry, toSingleLine } from '../src/routes/control-log.js'

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

// ============ ① toSingleLine ============

test('control-log: toSingleLine 把换行变成字面 \\n，保证 jsonl 一行一条', () => {
  assert.equal(toSingleLine('a\nb\r\nc', 100), 'a\\nb\\nc')
  assert.equal(toSingleLine('a\rb', 100), 'ab')
})

test('control-log: toSingleLine 丢弃不可见控制字符（\\t / 退格），保留可打印字符', () => {
  assert.equal(toSingleLine('a\tb\u0007c\bd', 100), 'abcd')
  assert.equal(toSingleLine('中文 · emoji 🚀', 100), '中文 · emoji 🚀')
})

test('control-log: toSingleLine 超长截断并加省略号', () => {
  const out = toSingleLine('x'.repeat(50), 10)
  assert.equal(out, `${'x'.repeat(10)}…`)
  assert.equal(toSingleLine('short', 10), 'short', '未超限不得加省略号（否则每次读数都被人为放大）')
})

// ============ ② buildRejectEntry ============

test('control-log: syntax 分支的条目带 truncated / error / 与响应同口径的体积', () => {
  const script = '#! /usr/bin/env node\n// @desc x\n// @why y\nconst a = (\n'
  const e = buildRejectEntry(script, 'syntax', {
    sid: 'sess-1',
    error: 'Unexpected end of input（前 80 字符：…）',
    truncated: true,
    sizeScope: 'effective',
  })
  assert.equal(e.channel, 'run')
  assert.equal(e.kind, 'syntax')
  assert.equal(e.sid, 'sess-1')
  assert.equal(e.truncated, true)
  assert.equal(e.sizeScope, 'effective')
  assert.equal(e.bytes, Buffer.byteLength(script, 'utf8'))
  assert.equal(e.lines, script.split('\n').length)
  assert.equal(e.overBudget, false, '这份样例远未超预算 —— overBudget 必须是真的量出来的，不是常量')
  assert.ok(e.head.startsWith('#! /usr/bin/env node'))
  assert.ok(!e.head.includes('\n'), 'head 必须单行化，否则 jsonl 结构坏掉')
})

test('control-log: overBudget 跟随输入变化（12KB / 300 行 §10 预算）', () => {
  const big = `#! /usr/bin/env node\n// @desc x\n// @why y\nconsole.log('${'z'.repeat(13 * 1024)}')`
  const e = buildRejectEntry(big, 'syntax', { sizeScope: 'effective' })
  assert.equal(e.overBudget, true, '> 12KB 必须判超预算 —— 这是「这轮本来就写不完」的唯一线索')
  assert.ok(e.bytes > 12 * 1024)
})

test('control-log: empty / head-contract 分支不带 syntax 专属字段，reason 单行化', () => {
  const empty = buildRejectEntry('', 'empty')
  assert.equal(empty.kind, 'empty')
  assert.equal(empty.bytes, 0)
  assert.equal(empty.truncated, undefined, '非 syntax 分支不得凭空生出 truncated（会污染「截断频次」统计）')
  assert.equal(empty.error, undefined)
  const head = buildRejectEntry('#!/bin/sh\nls', 'head-contract', { reason: 'ILLEGAL_SHEBANG: /bin/sh\n(第二行)' })
  assert.equal(head.reason, 'ILLEGAL_SHEBANG: /bin/sh\\n(第二行)')
  assert.equal(head.head, '#!/bin/sh\\nls', 'head 里的换行同样要单行化')
})

test('control-log: 体积口径可区分 raw / effective（与响应体 scriptSize 必须可比）', () => {
  const e = buildRejectEntry('console.log(1)', 'syntax', { sizeScope: 'effective' })
  assert.equal(e.sizeScope, 'effective')
  assert.equal(buildRejectEntry('console.log(1)', 'syntax').sizeScope, 'raw', '缺省口径应为 raw')
})

// ============ ③ boardKeysOf / buildBoardEntry ============

test('control-log: boardKeysOf 按 mode 推导顺序取键，items 走计数占位', () => {
  assert.deepEqual(boardKeysOf({ pushTodo: ['A', 'B'] }), ['A', 'B'])
  assert.deepEqual(boardKeysOf({ complete: ['C'] }), ['C'])
  assert.deepEqual(boardKeysOf({ start: ['D'] }), ['D'])
  assert.deepEqual(boardKeysOf({ fail: ['E'] }), ['E'])
  assert.deepEqual(boardKeysOf({}), [])
  assert.deepEqual(boardKeysOf({ items: [1, 2, 3] }), ['<items:3>'])
  // shift/rotate 场景：pushTodo 优先于 complete（与 task-store 的 mode 推导同序）
  assert.deepEqual(boardKeysOf({ pushTodo: ['A'], complete: ['B'] }), ['A'])
})

test('control-log: buildBoardEntry 报出落盘后的四态计数（AI 声称 vs 看板真实状态的对齐点）', () => {
  const out = {
    warnings: ['complete 未命中: 段九'],
    degraded: false,
    attempts: 1,
    state: { items: [{ status: 'done' }, { status: 'pending' }, { status: 'pending' }, { status: 'failed' }, { status: 'running' }] },
  }
  const e = buildBoardEntry({ mode: 'complete', complete: ['段一'] }, out, 'sess-a')
  assert.equal(e.channel, 'tasks')
  assert.equal(e.mode, 'complete')
  assert.deepEqual(e.keys, ['段一'])
  assert.deepEqual([e.pending, e.running, e.done, e.failed], [2, 1, 1, 1])
  assert.deepEqual(e.warnings, ['complete 未命中: 段九'])
  assert.equal(e.degraded, false)
  assert.equal(e.attempts, 1)
  assert.equal(e.sid, 'sess-a')
})

test('control-log: buildBoardEntry 对残缺输入不抛（日志绝不能成为新的故障点）', () => {
  const e = buildBoardEntry({}, {}, undefined)
  assert.equal(e.mode, '(auto)')
  assert.deepEqual(e.keys, [])
  assert.deepEqual([e.pending, e.running, e.done, e.failed], [0, 0, 0, 0])
  assert.deepEqual(e.warnings, [])
  assert.equal(e.degraded, false)
  assert.equal(e.sid, '')
})

// ============ ④ 接线：留痕必须落在真会走到的分支上，且在响应之前 ============

test('control-log: run.ts 的三个 400 分支各自留痕，且都在对应的响应之前', () => {
  const src = read('packages/core/src/routes/run.ts')
  // 用正则而非字符串字面量定位：被测代码片段里本身含单引号（logReject('', 'empty')）
  const at = (re: RegExp) => {
    const i = src.search(re)
    assert.ok(i >= 0, `run.ts 缺少 ${String(re)}`)
    return i
  }
  const emptyLog = at(/logReject\('', 'empty'\)/)
  const headLog = at(/logReject\(script, 'head-contract'/)
  const syntaxLog = at(/logReject\(effectiveScript, 'syntax'/)
  const emptyResp = at(/error: '脚本为空'/)
  const headResp = at(/metaError: true/)
  const syntaxResp = at(/syntaxError: true/)
  assert.ok(emptyLog < emptyResp, '空脚本留痕必须在返回之前，否则被拒的脚本永远没人看见')
  assert.ok(headLog < headResp, '契约违规留痕必须在返回之前')
  assert.ok(syntaxLog < syntaxResp, '语法/截断留痕必须在返回之前')
  // 三个分支各调用一次（重复调用会让同一轮记多条，污染「拒收频次」统计）。
  // 定义处是 `const logReject = (…) =>`，不匹配 `logReject(`，故调用点数即出现数。
  assert.equal(src.split('logReject(').length - 1, 3, 'logReject 调用点应恰好 3 处（empty / head-contract / syntax）')
  assert.ok(src.includes('const logReject = ('), 'logReject 定义缺失')
})

test('control-log: tasks.ts 的写路径必须留痕（含 degraded 与 warnings 透出）', () => {
  const src = read('packages/core/src/routes/tasks.ts')
  assert.match(src, /writeChannelLog\('board', buildBoardEntry\(/, '看板写请求没有留痕 ⇒ 「AI 声称已 complete」无法证实/证伪')
  assert.ok(
    src.search(/writeChannelLog\('board'/) < src.indexOf('return c.json({\n    ...out.state'),
    '留痕必须在返回之前',
  )
})

test('control-log: LogChannel 已接纳控制面通道（reject / board / send）', () => {
  const src = read('packages/core/src/state/snapshot.ts')
  const m = src.match(/export type LogChannel = ([^\n]+)/)
  assert.ok(m, 'LogChannel 声明缺失 ⇒ 写这些通道会被类型检查挡下（或静默落到别处）')
  // [send-trace-v1] 由「逐字快照整行」改为「逐通道包含」：原断言把新增通道也变成一次改动成本，
  //   而它真正要防的是**移除**（通道没了 ⇒ writeChannelLog 的入参类型不再接纳 ⇒ 静默落到别处）。
  //   逐通道包含同样能抓到移除（承重不变），且不再阻塞扩展。
  for (const ch of ['reject', 'board', 'send']) {
    assert.ok((m as RegExpMatchArray)[1].includes(`'${ch}'`), `LogChannel 缺 '${ch}' ⇒ 写 ${ch}.jsonl 的类型契约不成立`)
  }
})
