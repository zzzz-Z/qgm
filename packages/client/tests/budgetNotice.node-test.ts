// [budget-notice-honest-v1] 守卫：体积回执**只报可测量，不给无依据建议**。
//
// 背景：`summary` 帧原先不带 `scriptSize`——只有被 4xx 拦下的那一轮才附带体积。
// 补上体积下发是对的；但**旧实现据此给出行动建议**（「余量充足，可以多推进」/「主动拆小」）
// 是判据真空：§10 的约束是 T + S ≤ B，而 T 服务端测不到 ⇒ 任何「还能写多少」的结论都缺依据，
// 且「余量充足」恰好会诱导 AI 加大输出、触发它想避免的截断（2026-10-12 用户指出）。
//
// 本文件守护四件事：
//   ① 只报可测的量：脚本块行数/字节/占比，且显式声明「不含 T」；
//   ② 不给建议：不得出现「余量充足 / 主动拆小 / 可以多推进」等行动指引；
//   ③ 判据互斥：前置拦截轮（无 runId）不得产出体积块；
//   ④ 接线结构：服务端每轮下发 scriptSize、客户端解析并接入 prompt。
import { it } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { appendBudgetNotice } from '../components/script/prompt-builder.js'

const ROOT = process.cwd()
const RUN_ROUTE_SRC = 'packages/core/src/routes/run.ts'
const RUNNER_SRC = 'packages/client/composables/runner/useRunner.ts'
const ACTIONS_SRC = 'packages/client/components/script/script-panel-actions.ts'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/**
 * 造一个「脚本真跑过」形态的结果
 * [CONSTRAINT] runId 是判据本身（非空 = 跑过），默认必须给，否则所有用例都退化成空断言
 */
function ran(sizeOver: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): string {
  const p: string[] = []
  appendBudgetNotice(p, {
    runId: '1700000000000-abcd',
    code: 0,
    ok: true,
    scriptSize: { lines: 60, bytes: 2 * 1024, overBudget: false, maxLines: 300, maxBytes: 12 * 1024, ...sizeOver },
    ...extra,
  })
  return p.join(String.fromCharCode(10))
}
it('报告可测量：行数 / 字节 / 占比，且标明「服务端实测」', () => {
  const text = ran()
  assert.match(text, /本轮输出体积/)
  assert.match(text, /服务端实测/)
  assert.match(text, /上一轮脚本块：60 行 \/ 2\.0 KB/)
  assert.match(text, /300 行 \/ 12 KB/)
  assert.match(text, /非闸门/)
  assert.doesNotMatch(text, /硬上限/)
  assert.match(text, /占安全工作区 20%/)
})

it('[核心契约] 必须显式声明「不含 T」：否则占比会被误读为整轮余量', () => {
  const text = ran()
  assert.match(text, /不含思考量 T/)
  assert.match(text, /无法据此判断剩余预算/)
})

it('[核心契约] 不得给出行动建议：判据不支持（判据真空的回归守卫）', () => {
  for (const sizeOver of [{}, { lines: 250 }, { lines: 480, bytes: 14 * 1024, overBudget: true }]) {
    const text = ran(sizeOver)
    assert.doesNotMatch(text, /余量充足/)
    assert.doesNotMatch(text, /主动拆小/)
    assert.doesNotMatch(text, /可以适度多推进/)
    assert.doesNotMatch(text, /不必把一轮能做完的事拆成多轮/)
  }
})

it('超预算时只说事实，不给「务必拆成多个小脚本」这类建议', () => {
  const text = ran({ lines: 480, bytes: 14 * 1024, overBudget: true })
  assert.match(text, /已超安全工作区/)
  assert.doesNotMatch(text, /务必拆成多个小脚本/)
})
it('判据互斥：前置拦截轮（无 runId）不得产出体积块', () => {
  // 那一轮的体积由 appendScriptInvalid 作为「为什么被截断」的因果解释给出；
  // 两处都输出会让 AI 收到两份措辞不同的体积账本。
  assert.equal(ran({}, { runId: '', code: 400, ok: false }), '')
})

it('无 scriptSize（老服务端 / 未下发）时不产出，而不是产出「0 行」的假数据', () => {
  assert.equal(ran({}, { scriptSize: undefined }), '')
})

it('null 结果不产出', () => {
  const p: string[] = []
  appendBudgetNotice(p, null)
  assert.equal(p.join(''), '')
})
// ── 接线结构断言：防「函数写了但没接上」────────────────────────────────────

it('wiring: run.ts 的 summary 帧（不只 400 分支）必须下发 scriptSize', () => {
  const src = read(RUN_ROUTE_SRC)
  const hits = src.split('scriptSize: measureScriptSize(effectiveScript)').length - 1
  assert.ok(hits >= 2, `scriptSize 应在 400 分支与 summary 帧各下发一次，实际 ${hits} 处`)
  assert.match(
    src,
    /scriptCtx: scriptMeta\.ctx,[\s\S]{0,600}?scriptSize: measureScriptSize\(effectiveScript\)/,
    'summary 帧未下发 scriptSize：正常轮拿不到体积',
  )
})

it('wiring: useRunner 的 summary 解析必须把 scriptSize 落进 result', () => {
  const src = read(RUNNER_SRC)
  assert.match(
    src,
    /scriptSize: \(s\.scriptSize as RunResponse\['scriptSize'\]\) \?\? undefined/,
    'summary 帧解析未落 scriptSize，prompt 侧读不到',
  )
})

it('wiring: buildAiPrompt 必须调用 appendBudgetNotice，且紧跟反馈摘要之后', () => {
  const src = read(ACTIONS_SRC)
  assert.match(src, /appendBudgetNotice\(p, r\)/, 'buildAiPrompt 未接线')
  const feedbackAt = src.indexOf('appendFeedbackSummary(p, r)')
  const budgetAt = src.indexOf('appendBudgetNotice(p, r)')
  assert.ok(feedbackAt > 0 && budgetAt > 0, '两处调用都必须存在')
  assert.ok(budgetAt > feedbackAt, '体积账本应排在反馈摘要之后')
})
