// [budget-feedback-v1] 守卫：**每一轮**都要把「上一轮实测体积 / §10 预算」带回 AI 决策回路。
//
// 背景：`summary` 帧原先不带 `scriptSize`——只有被 4xx 拦下的那一轮才附带体积。
// 于是 AI 在正常轮里完全看不到自己写了多长（它看不到 token 计数，也数不准行数），
// 只能一路加码直到某轮被截断，才知道「墙」在哪。「越跑越长 → 越容易截断」的正反馈由此形成。
//
// 本文件守护四件事：
//   ① 分档正确：余量充足 / 接近上限 / 已超预算 三档不得互相串味；
//   ② 判据互斥：前置拦截轮（无 runId）不得产出体积块——体积已由 appendScriptInvalid 说明；
//   ③ 措辞双向：既能催 AI 拆小，也能告诉它「还能写」（单向只会导致过度拆分、白烧轮次）；
//   ④ 接线结构：服务端每轮下发 scriptSize、客户端解析并接入 prompt。
import { it } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { appendBudgetNotice, BUDGET_WARN_RATIO } from '../components/script/prompt-builder.js'

const ROOT = process.cwd()
const RUN_ROUTE_SRC = 'packages/core/src/routes/run.ts'
const RUNNER_SRC = 'packages/client/composables/runner/useRunner.ts'
const ACTIONS_SRC = 'packages/client/components/script/script-panel-actions.ts'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

it('常量：预警线必须严格小于 1，否则「接近上限」这一档永不触发（死分支）', () => {
  assert.ok(BUDGET_WARN_RATIO > 0 && BUDGET_WARN_RATIO < 1, `BUDGET_WARN_RATIO=${BUDGET_WARN_RATIO} 必须落在 (0,1) 开区间`)
})

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
  return p.join('\n')
}

it('余量充足：说清「还能写」，且不得出现拆小措辞（单向催促会导致过度拆分）', () => {
  const text = ran()
  assert.match(text, /本轮输出体积/)
  assert.match(text, /60 行 \/ 2\.0 KB/)
  // §10 现行口径：300 行 / 12 KB 是「非拦截闸门 + 确定性安全工作区」，不得再写成「硬上限」
  assert.match(text, /非闸门，超限只留痕不拦截/)
  assert.match(text, /300 行 \/ 12 KB 是确定性安全工作区/)
  assert.doesNotMatch(text, /硬上限/)
  assert.match(text, /单轮建议 ≤ 150 行/)
  assert.match(text, /余量充足（已用 20%）/)
  assert.match(text, /不必把一轮能做完的事拆成多轮/)
  // [token-budget-v1] 横幅只测 S（服务端测不到 T），须显式声明，防止「余量充足」被误读为整轮安全
  assert.match(text, /只计脚本 S/)
  assert.doesNotMatch(text, /主动拆小/)
  assert.doesNotMatch(text, /已超预算/)
})

it('接近上限（行维度）：提示主动拆小', () => {
  const text = ran({ lines: 250 })
  assert.match(text, /已用掉 83% 的预算/)
  assert.match(text, /主动拆小/)
  assert.doesNotMatch(text, /已超预算/)
  assert.doesNotMatch(text, /余量充足/)
})

it('接近上限（字节维度）：行数没超但字节超线，同样必须触发', () => {
  // 行 60（20%）看着很安全，但字节 9.8 KB（80%）已经贴到上限——
  // 只看行数会漏判：长行（内嵌模板字符串）正是字节先爆的典型形态。
  const text = ran({ bytes: Math.ceil(12 * 1024 * 0.8) })
  assert.match(text, /主动拆小/)
  assert.match(text, /已用掉 80% 的预算/)
})

it('已超预算：给更强的措辞（「完整到达属于侥幸」），不得降级成普通预警', () => {
  const text = ran({ lines: 480, bytes: 14 * 1024, overBudget: true })
  assert.match(text, /\*\*已超预算\*\*/)
  assert.match(text, /用掉 160%/)
  assert.match(text, /务必拆成多个小脚本/)
  assert.doesNotMatch(text, /余量充足/)
})

it('阈值边界：恰好等于预警线即触发，略低一线不触发', () => {
  assert.match(ran({ lines: 300 * BUDGET_WARN_RATIO }), /主动拆小/)
  assert.match(ran({ lines: 300 * BUDGET_WARN_RATIO - 1 }), /余量充足/)
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

it('文案必须标明「服务端实测」：AI 无法自测，数据来源决定它是否该信', () => {
  assert.match(ran(), /服务端实测/)
})

// ── 接线结构断言：防「函数写了但没接上」────────────────────────────────────

it('wiring: run.ts 的 summary 帧（不只 400 分支）必须下发 scriptSize', () => {
  const src = read(RUN_ROUTE_SRC)
  const hits = src.split('scriptSize: measureScriptSize(effectiveScript)').length - 1
  assert.ok(hits >= 2, `scriptSize 应在 400 分支与 summary 帧**各**下发一次，实际命中 ${hits} 处`)
  // 锚定 summary 帧：scriptCtx 只在 summary 帧出现
  assert.match(
    src,
    /scriptCtx: scriptMeta\.ctx,[\s\S]{0,600}?scriptSize: measureScriptSize\(effectiveScript\)/,
    'summary 帧未下发 scriptSize：正常轮拿不到体积，每轮配额反馈就成了空转',
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
  assert.match(src, /appendBudgetNotice\(p, r\)/, 'buildAiPrompt 未接线：函数写了也白写')
  const feedbackAt = src.indexOf('appendFeedbackSummary(p, r)')
  const budgetAt = src.indexOf('appendBudgetNotice(p, r)')
  assert.ok(feedbackAt > 0 && budgetAt > 0, '两处调用都必须存在')
  assert.ok(budgetAt > feedbackAt, '体积账本应排在「这轮结果如何」之后：先看结果，再看用掉多少预算')
})
