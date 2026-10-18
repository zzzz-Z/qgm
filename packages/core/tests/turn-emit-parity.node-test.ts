// [turn-emit-v1] 油猴侧信封分帧的守卫：**行为对拍** + 去重 + 帧 shape。
//
// [WHY] 油猴片段无法 import（IIFE 物理切分），唯一的可测方式是「剥类型 → vm 真跑」。
//   只断言源码里出现某行文字是不够的：`turnBlocksToFrames` 与核心 `blocksToFrames`
//   必须对同一批块产出**逐字节相同**的帧，否则前端「采信守卫」立刻失去意义。
//
// 对拍口径：两端共用同一个 `parseTurn`（核心实现；解析器本身的对拍在 P1-c 已做），
//   只比「块列表 → 帧」这一层。这是本用例唯一想钉死的东西。
//
// [CONSTRAINT] 跨 realm 比较前必须 JSON 扁平化（vm 造的对象原型链与宿主不同）。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import vm from 'node:vm'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import { blocksToFrames } from '../src/reply/turn-frames.js'
import type { RawBlock } from '../src/reply/turn-frames.js'
import { parseTurn } from '../src/reply/turn-schema.js'

const SEGMENT = 'packages/core/src/tampermonkey/turn-emit.ts'

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8')
}

function flat<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v))
}

interface Posted {
  type: string
  block?: Record<string, unknown>
  end?: Record<string, unknown>
  site?: string
  sessionId?: string
}

interface OilExports {
  turnBlocksToFrames: (turnId: number, raw: unknown[]) => { blocks: unknown[], end: Record<string, unknown> }
  turnAwaiting: (blocks: unknown[]) => string
  readTurnFromRoot: (root: unknown) => { turnId: number, blocks: unknown[] } | null
  emitTurn: (turn: unknown) => boolean
}

/** 剥类型后在独立上下文里真跑片段；依赖全部注入 */
function buildOil(): { oil: OilExports, posted: Posted[] } {
  const posted: Posted[] = []
  const js = ts.transpileModule(read(SEGMENT), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText
  const ctx: Record<string, unknown> = {
    parseTurn,
    codeTextOf: (el: { textContent?: string } | null) => (el && el.textContent) || '',
    post: (m: Posted) => { posted.push(m) },
    location: { origin: 'https://example.com' },
    extractSidFromHash: () => 'sid-1',
    bodySignature: () => 'sig-1',
    console,
  }
  const oil = vm.runInNewContext(
    `${js}\n;({ turnBlocksToFrames, turnAwaiting, readTurnFromRoot, emitTurn })`,
    ctx,
  ) as OilExports
  return { oil, posted }
}

const { oil, posted } = buildOil()

// ── 对拍语料：覆盖四类块 + 各种「该被跳过」的残缺形态 ──

const FULL: RawBlock[] = [
  { type: 'say', id: 'say_1', text: '先探两路。' },
  { type: 'script', id: 'c1', lang: 'js', desc: '统计 md 分布', why: '决定先改哪几个', code: 'console.log(1)' },
  { type: 'script', id: 'c2', lang: 'cjs', desc: '确认工作区干净', why: '避免覆盖未提交', code: 'module.exports = 1' },
  { type: 'ask', id: 'q1', question: '要清理临时文件吗？', options: [{ id: 'a', label: '清理' }, { id: 'b', label: '跳过' }] },
]

const CASES: { name: string, raw: RawBlock[] }[] = [
  { name: '四块齐全（say+2script+ask）', raw: FULL },
  { name: '只有 say', raw: [FULL[0]!] },
  { name: '只有 script', raw: [FULL[1]!] },
  { name: 'handoff', raw: [{ type: 'handoff', id: 'h1', summary: '上下文要满了' }] },
  { name: 'ask 无 options', raw: [{ type: 'ask', id: 'q2', question: '继续？' }] },
  { name: 'ask option 缺 label', raw: [{ type: 'ask', id: 'q3', question: '选一个', options: [{ id: 'a' }, { id: 'b', label: 'B' }] }] },
  { name: 'script 缺 desc（应进 skipped）', raw: [{ type: 'script', id: 'c3', lang: 'js', desc: '', why: 'w', code: 'x' }] },
  { name: 'script lang 非法（应进 skipped）', raw: [{ type: 'script', id: 'c4', lang: 'python', desc: 'd', why: 'w', code: 'x' }] },
  { name: 'say 空文本（应进 skipped）', raw: [{ type: 'say', id: 's2', text: '   ' }] },
  { name: '未知 type（应进 skipped）', raw: [{ type: 'lane', id: 'x' } as unknown as RawBlock] },
  { name: '全非法 ⇒ 0 块', raw: [{ type: 'say', id: 's3', text: '' }] },
]

describe('turnBlocksToFrames 与核心 blocksToFrames 逐例相同', () => {
  for (const c of CASES) {
    test(c.name, () => {
      const mine = flat(oil.turnBlocksToFrames(9, c.raw as unknown[]))
      const core = flat(blocksToFrames(9, c.raw))
      expect(mine).toEqual(core)
    })
  }

  test('seq 取数组下标，跳过的块在 seq 上留空洞', () => {
    const raw: RawBlock[] = [
      { type: 'say', id: 's', text: 'ok' },
      { type: 'say', id: 'bad', text: '' },
      { type: 'handoff', id: 'h', summary: 'done' },
    ]
    const got = flat(oil.turnBlocksToFrames(1, raw)) as { blocks: { seq: number }[], end: { skipped: string[] } }
    expect(got.blocks.map(b => b.seq)).toEqual([0, 2])
    expect(got.end.skipped).toEqual(['bad:text'])
  })

  test('awaiting 优先级 script > ask > none', () => {
    expect(oil.turnAwaiting([{ type: 'say' }])).toBe('none')
    expect(oil.turnAwaiting([{ type: 'say' }, { type: 'ask' }])).toBe('user')
    expect(oil.turnAwaiting([{ type: 'ask' }, { type: 'script' }])).toBe('results')
    expect(oil.turnAwaiting([])).toBe('none')
  })
})

// ── readTurnFromRoot：从页面读信封 ──

function makePre(preText: string, codeText?: string): unknown {
  const codeEl = codeText === undefined ? null : { textContent: codeText }
  return { textContent: preText, querySelector: (sel: string) => (sel === 'code' ? codeEl : null) }
}

function makeRoot(pres: unknown[]): unknown {
  return { querySelectorAll: (sel: string) => (sel === 'pre' ? pres : []) }
}

function envelope(obj: unknown): string {
  return `\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\``
}

describe('readTurnFromRoot：从最后一条回复读信封', () => {
  test('命中信封 ⇒ 带出 turnId 与块（顺序 == content 数组顺序）', () => {
    const got = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, turn: 5, content: [FULL[1], FULL[0], FULL[2]] }))]))
    expect(got!.turnId).toBe(5)
    expect((got!.blocks as { id: string }[]).map(b => b.id)).toEqual(['c1', 'say_1', 'c2'])
  })

  test('多个围栏时取最后一个（信封永远是最后交付的）', () => {
    const got = oil.readTurnFromRoot(makeRoot([
      makePre(envelope({ v: 1, turn: 1, content: [FULL[0]] })),
      makePre(envelope({ v: 1, turn: 2, content: [FULL[1]] })),
    ]))
    expect(got!.turnId).toBe(2)
  })

  test('无信封 / 半截信封 / 空容器 ⇒ null（旧标记链路原样接管）', () => {
    expect(oil.readTurnFromRoot(makeRoot([makePre('SCRIPT\n```js\nconsole.log(1)\n```')]))).toBeNull()
    expect(oil.readTurnFromRoot(makeRoot([makePre('普通回复')]))).toBeNull()
    expect(oil.readTurnFromRoot(makeRoot([]))).toBeNull()
    expect(oil.readTurnFromRoot(null)).toBeNull()
    const half = envelope({ v: 1, turn: 4, content: [FULL[0], FULL[1]] }).slice(0, -30)
    expect(oil.readTurnFromRoot(makeRoot([makePre(half)]))).toBeNull()
  })

  test('turn 缺省 ⇒ 0（不丢帧，前端按 0 归组）', () => {
    const got = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, content: [FULL[0]] }))]))
    expect(got!.turnId).toBe(0)
  })

  test('同一段文本既有闭合信封又有新的未闭合信封 ⇒ null（不把上一版当新内容交付）', () => {
    // [WHY] 这是 truncated 闸门**唯一承重**的场景：parseTurn 从后往前找候选，
    //   最后一个候选未闭合 ⇒ truncated=true，但它会继续往前找到那个**闭合的旧信封**并返回其 blocks。
    //   没有闸门 ⇒ 「上一条已交付的信封」被当成当前回复再推一遍（重复执行）。
    const closedOld = envelope({ v: 1, turn: 1, content: [FULL[0]] })
    const openNew = envelope({ v: 1, turn: 2, content: [FULL[1], FULL[2]] }).slice(0, -40)
    expect(oil.readTurnFromRoot(makeRoot([makePre(`${closedOld}\n\n${openNew}`)]))).toBeNull()
  })

  test('已闭合信封后跟无关文本 ⇒ 仍能读出来（闸门只挡未闭合的）', () => {
    const closed = envelope({ v: 1, turn: 3, content: [FULL[1]] })
    const got = oil.readTurnFromRoot(makeRoot([makePre(`${closed}\n\n以上是这轮的交付。`)]))
    expect(got!.turnId).toBe(3)
  })
})

// ── emitTurn：帧序列 / 去重 / shape ──

describe('emitTurn：帧序列与去重', () => {
  test('每块一帧 + 末尾一个结束帧；shape 与前端 handleBlockMsg 对齐', () => {
    posted.length = 0
    const turn = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, turn: 11, content: FULL }))]))
    expect(oil.emitTurn(turn)).toBe(true)
    expect(posted.map(m => m.type)).toEqual([
      'ai-runner:block',
      'ai-runner:block',
      'ai-runner:block',
      'ai-runner:block',
      'ai-runner:turn-end',
    ])
    const first = posted[0]!
    expect(first.block).toMatchObject({ turnId: 11, blockId: 'say_1', seq: 0, type: 'say', text: '先探两路。' })
    expect(first.site).toBe('https://example.com')
    expect(first.sessionId).toBe('sid-1')
    // say 帧不得带 code（字段串味会让采信守卫失效）
    expect(first.block!.code).toBeUndefined()
    const end = posted[posted.length - 1]!
    expect(end.end).toMatchObject({ turnId: 11, awaiting: 'results', blocks: 4 })
    // 结束帧只带 end，不带 block
    expect(end.block).toBeUndefined()
  })

  test('重复扫到同一信封 ⇒ 一帧都不再发，但仍返回 true（否则会回落 plain 推 JSON）', () => {
    posted.length = 0
    const turn = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, turn: 12, content: FULL }))]))
    expect(oil.emitTurn(turn)).toBe(true)
    const firstCount = posted.length
    expect(firstCount).toBe(5)
    expect(oil.emitTurn(turn)).toBe(true)
    expect(posted.length).toBe(firstCount)
  })

  test('新 turn 照常发（去重键含 turnId，不会把下一轮吞掉）', () => {
    posted.length = 0
    const t1 = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, turn: 13, content: [FULL[0]] }))]))
    const t2 = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, turn: 14, content: [FULL[0]] }))]))
    oil.emitTurn(t1)
    oil.emitTurn(t2)
    expect(posted.filter(m => m.type === 'ai-runner:block')).toHaveLength(2)
    expect(posted.filter(m => m.type === 'ai-runner:turn-end').map(m => m.end!.turnId)).toEqual([13, 14])
  })

  test('没有可用块 ⇒ 返回 false（让旧路径兜住，不吞掉整条回复）', () => {
    posted.length = 0
    expect(oil.emitTurn(null)).toBe(false)
    expect(oil.emitTurn({ turnId: 1, blocks: [] })).toBe(false)
    expect(oil.emitTurn({ turnId: 2, blocks: [{ type: 'say', id: 's', text: '' }] })).toBe(false)
    expect(posted).toHaveLength(0)
  })

  test('turn-end 的 awaiting 与帧内容一致（有 script ⇒ results）', () => {
    posted.length = 0
    const askOnly = oil.readTurnFromRoot(makeRoot([makePre(envelope({ v: 1, turn: 15, content: [FULL[3]] }))]))
    oil.emitTurn(askOnly)
    expect(posted[posted.length - 1]!.end).toMatchObject({ turnId: 15, awaiting: 'user', blocks: 1 })
  })
})

// ── 接线守卫：dispatch 必须真的调它 ──

test('dispatch 在分流最前面调 readTurnFromRoot + emitTurn，且信封优先于 marks 扫描', () => {
  const src = read('packages/core/src/tampermonkey/dispatch.ts')
  const turnAt = src.indexOf('readTurnFromRoot(replyRoot)')
  const marksAt = src.indexOf('scanReplyMarks(replyRoot')
  assert.ok(turnAt > 0, 'dispatch 未接线 readTurnFromRoot：P3 等于没做')
  assert.ok(marksAt > 0, 'dispatch 缺 scanReplyMarks（旧路径被整体删除？）')
  assert.ok(turnAt < marksAt, '信封分支必须在 marks 扫描之前：marks 会把信封 JSON 判成 text/done 而整轮跳过 script')
  assert.match(src, /if \(turn && emitTurn\(turn\)\) return/, 'emitTurn 的返回值必须被用来中断分流')
})

test('片段清单含 turn-schema 与 turn-emit，且 turn-schema 在 turn-emit 之前', () => {
  const src = read('scripts/lib/userscript-segments.mjs')
  const schemaAt = src.indexOf(`'turn-schema'`)
  const emitAt = src.indexOf(`'turn-emit'`)
  assert.ok(schemaAt > 0, 'SEGMENTS 缺 turn-schema：油猴产物里没有 parseTurn，信封永远读不出来')
  assert.ok(emitAt > 0, 'SEGMENTS 缺 turn-emit')
  assert.ok(schemaAt < emitAt, 'turn-schema 必须在 turn-emit 之前（const 声明不提升，TDZ）')
})
