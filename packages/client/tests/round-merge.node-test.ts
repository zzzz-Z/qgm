// [round-merge-v1] 轮内结果合并窗 · 行为级判据
//
// 要守的命题：**一条含 N 块的 AI 回复，只向 AI 回传 1 次**（而不是 N 次）。
//
// 为什么不能只守「队列为空」这个旧判据：页面侧是**逐块推送**的，块间固定 80ms
// （scripts/tampermonkey-session-id.user.js:668 `if (hasMoreUnseenBlocks()) setTimeout(classifyAndPost, 80)`）。
// 于是任何耗时 < 80ms 的块（拒收几乎瞬时：reject.jsonl 的 start == end）结束时，下一块**还没入库**，
// 「队列为空」恒成立 ⇒ 逐块出站。实盘复算（.ai-runner/tmp/reject-cascade-probe.cjs，按 sid 分组）：
//   10-06 同 sid 亚秒级拒收级联 63 条、最长 13 块，其中 146 次出站属同回复的非首块。
// 本文件用假定时器**真实驱动** pending-scripts 的合并窗，把「N 块 1 次」钉成行为判据
// （接线结构由 multiScriptQueue.node-test.ts 守）。
import { afterEach, beforeEach, test, vi } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  cancelRoundMerge,
  clearScripts,
  enqueueScript,
  peekRoundOutcomes,
  ROUND_MERGE_MS,
  shiftScript,
  stageRoundOutcome,
} from '../composables/ai/auto-loop/pending-scripts'
import {
  buildLoopResultPrompt,
  buildRoundBatchPrompt,
  classifyRoundFailure,
} from '../composables/ai/auto-loop/loop-result-prompt'
import type { RoundOutcome } from '../composables/ai/auto-loop/types'
import type { InboxItem } from '../composables/runner/useScriptInbox'

const L = 'RM1'

function outcome(desc: string, over: Partial<RoundOutcome> = {}): RoundOutcome {
  return {
    lang: 'cjs',
    desc,
    exit: 0,
    ok: true,
    stdout: '',
    stderr: '',
    changeCount: 0,
    changedFiles: [],
    ...over,
  }
}

/** 造一个「被 /run 前置拒收」的结果，正文按 run.ts 的真实响应体摊平形态（useRunner 把它放进 stderr） */
function rejected(desc: string, body: Record<string, unknown>): RoundOutcome {
  return outcome(desc, { ok: false, exit: 400, stderr: `HTTP 400 Bad Request\n${JSON.stringify(body)}` })
}

function item(hash: string): InboxItem {
  return { id: `inb_${hash}`, code: `// ${hash}`, lang: 'js', site: 'test', hash, desc: '', why: '', ts: 0 }
}

beforeEach(() => {
  vi.useFakeTimers()
  clearScripts(L)
})

afterEach(() => {
  cancelRoundMerge(L)
  clearScripts(L)
  vi.useRealTimers()
})

test('合并窗：一条回复多块逐块完成 ⇒ 只出站 1 次，且文案含块数与失败分桶', () => {
  const sent: string[] = []
  const flush = (os: RoundOutcome[]): boolean => { sent.push(buildRoundBatchPrompt(os)); return true }

  // 级联总跨度 1600ms > 窗口 1500ms：只有「每来一块就顺延窗口」才可能合并成 1 次
  // （若只在首块起算，此处会切成 2 次 —— 这正是「逐块回传」在实盘里的形态）
  const bodies: Array<Record<string, unknown>> = [
    { error: '脚本头契约违规：MISSING_WHY' },
    { error: '脚本头契约违规：MISSING_WHY' },
    { error: '脚本头契约违规：ILLEGAL_SHEBANG: #!/bin/sh' },
    { error: '脚本语法错误：Unexpected end of input', truncated: true },
    { error: '脚本头契约违规：MISSING_DESC' },
  ]
  for (let i = 0; i < bodies.length; i++) {
    if (i > 0) vi.advanceTimersByTime(400)
    stageRoundOutcome(L, rejected(`块${i + 1}`, bodies[i]), flush)
  }

  vi.advanceTimersByTime(ROUND_MERGE_MS - 1)
  assert.equal(sent.length, 0, '窗口未到不得出站：提前出站就是「逐块回传」放大器本身')

  vi.advanceTimersByTime(2)
  assert.equal(sent.length, 1, `窗口内完成的 ${bodies.length} 块必须合并成 1 次出站（N 块 1 次，不是 N 次）`)
  assert.match(sent[0], /本回复共 5 块（成功 0 · 失败 5）/)
  assert.match(sent[0], /缺 @why ×2/, '合并后必须能看到失败原因分桶（否则 AI 只能猜）')
  assert.match(sent[0], /shebang 非法 ×1/)
  assert.match(sent[0], /语法\+截断 ×1/)
  assert.equal(
    (sent[0].match(/请阅读终端输出并给出下一步。/g) || []).length,
    1,
    '收尾句在合并文本里只能出现一次（逐块堆叠会退化成「N 条拼在一起」）',
  )
  assert.equal((sent[0].match(/── 块 /g) || []).length, 5, '每块都要有独立小节，否则中间块的结果对 AI 不可见')
})

test('回归红线：单块出站文本与逐块时代逐字相同', () => {
  const sent: string[] = []
  const o = outcome('改两个文件', { changeCount: 2, changedFiles: ['a.ts', 'b.ts'] })
  stageRoundOutcome(L, o, (os) => { sent.push(buildRoundBatchPrompt(os)); return true })
  vi.advanceTimersByTime(ROUND_MERGE_MS + 1)
  assert.equal(sent.length, 1)
  assert.equal(
    sent[0],
    buildLoopResultPrompt(o),
    '单块回传文本被合并逻辑改写 → 既有回传语义漂移（AI 侧读到的格式变了）',
  )
})

test('合并窗不跨轮：两块间隔超过窗口 ⇒ 各自出站（不会把两轮结果错并）', () => {
  const sent: string[] = []
  const flush = (os: RoundOutcome[]): boolean => { sent.push(buildRoundBatchPrompt(os)); return true }
  stageRoundOutcome(L, outcome('上一轮'), flush)
  vi.advanceTimersByTime(ROUND_MERGE_MS + 1)
  assert.equal(sent.length, 1)
  stageRoundOutcome(L, outcome('下一轮'), flush)
  vi.advanceTimersByTime(ROUND_MERGE_MS + 1)
  assert.equal(sent.length, 2, '窗口无限顺延会把相邻两轮的结果错并成一条')
  assert.match(sent[1], /^【本轮执行结果】下一轮/, '后一条不得带上上一轮的内容')
})

test('队列仍有待执行块时不收口，且已完成的块结果不丢', () => {
  const sent: string[] = []
  const flush = (os: RoundOutcome[]): boolean => { sent.push(buildRoundBatchPrompt(os)); return true }

  enqueueScript(L, item('h2'))
  stageRoundOutcome(L, outcome('第一块（慢块，后续块已入队）'), flush)
  vi.advanceTimersByTime(ROUND_MERGE_MS * 2)
  assert.equal(sent.length, 0, '队列非空就收口 ⇒ 慢块把一条回复切成多次回传（合并失效）')
  assert.equal(peekRoundOutcomes(L).length, 1, '等待期间不得吞掉已完成的块结果')

  shiftScript(L)
  stageRoundOutcome(L, outcome('第二块'), flush)
  vi.advanceTimersByTime(ROUND_MERGE_MS + 1)
  assert.equal(sent.length, 1)
  assert.match(sent[0], /本回复共 2 块/, '队列排空后两块的累积结果必须一起出站')
})

test('出站守卫拒绝（暂停/失活）⇒ 丢弃且不补发', () => {
  let calls = 0
  stageRoundOutcome(L, outcome('块'), () => { calls += 1; return false })
  vi.advanceTimersByTime(ROUND_MERGE_MS * 3)
  assert.equal(calls, 1, 'flush 应被调用恰好一次')
  assert.equal(
    peekRoundOutcomes(L).length,
    0,
    '被守卫拒绝后不得留在缓冲里等下一轮补发（用户点了停止，迟到出站等于按不动）',
  )
})

test('终止/暂停撤下窗口 ⇒ 到点不再出站', () => {
  const cases: Array<[string, (id: string) => void]> = [
    ['cancelRoundMerge（finish 内调用）', (id: string) => { cancelRoundMerge(id) }],
    ['clearScripts（队列清空即撤窗）', (id: string) => { clearScripts(id) }],
  ]
  for (const [name, cancel] of cases) {
    let calls = 0
    const flush = (): boolean => { calls += 1; return true }
    stageRoundOutcome(L, outcome('x'), flush)
    cancel(L)
    vi.advanceTimersByTime(ROUND_MERGE_MS * 3)
    assert.equal(calls, 0, `${name}：未撤下窗口 → 循环已终止仍会有一条迟到的结果回传`)
    assert.equal(peekRoundOutcomes(L).length, 0, `${name}：缓冲未清空`)
  }
})

test('失败分桶：真实拒收样本各归其桶；成功块不分桶', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ error: '脚本头契约违规：MISSING_DESC' }, '缺 @desc'],
    [{ error: '脚本头契约违规：MISSING_WHY' }, '缺 @why'],
    [{ error: '脚本头契约违规：ILLEGAL_SHEBANG: #!/usr/bin/env bash（/run 仅执行 node 脚本）' }, 'shebang 非法'],
    [{ error: '脚本为空' }, '空脚本'],
    [{ error: '脚本语法错误：Unexpected end of input', truncated: true }, '语法+截断'],
    [{ error: '脚本语法错误：await is only valid in async functions', truncated: false }, '语法错误'],
  ]
  for (const [body, label] of cases) {
    assert.equal(classifyRoundFailure(rejected('块', body)), label, `${JSON.stringify(body)} 应归入「${label}」`)
  }
  assert.equal(classifyRoundFailure(outcome('成功')), '', '成功块不该出现在失败分桶里')
  assert.equal(
    classifyRoundFailure(outcome('bash 非零退出', { ok: false, exit: 1, stderr: 'boom' })),
    '执行失败',
    '普通执行失败应有兜底桶，不能落空',
  )
})

// ============ 接线结构断言（行为测不到的那一段）============

test('wiring: finish（循环终止/用户急停）必须撤下合并窗', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'packages/client/composables/ai/auto-loop/stop-and-finish.ts'), 'utf8')
  assert.ok(
    /cancelRoundMerge\(inst\.id\.value\)/.test(src),
    'finish 未撤下合并窗 → 用户点了停止，1.5s 后仍会有一条迟到的结果回传（停止形同按不动）',
  )
})
