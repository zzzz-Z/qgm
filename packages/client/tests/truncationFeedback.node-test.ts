// [truncation-detect-v1] 守卫：脚本被上游截断时，反馈必须走「通道故障 → 拆小重发」，
// 而不是被渲染成「退出码 400 → 原地重试」。
//
// 背景：`/__ai/run` 的 4xx 前置拦截（脚本头契约违规 / 语法错误 / 截断）此前只回一段裸文本，
// 客户端把它塞进 `# 错误输出 (stderr)`；`appendFeedbackSummary` 又报「行为层: 退出码 400」。
// AI 于是把「输出被切断」读成「运行时失败」，原地重发同样长的脚本 → 再次被切断 →
// 连续 2 次失败触发熔断冻结。用户实测表象即「应用端改一处就报一堆脚本被截断的错误」。
//
// 本文件守护三件事：
//   ① 文案本身：截断分支必须给出「拆成多个小脚本 / 串行执行 / 禁止原地重试」；
//   ② 不得串味：非截断分支不得出现截断措辞，且不再报「退出码 400」；
//   ③ 接线结构：run.ts 必须下发 truncated/scriptSize，客户端必须解析并接入 prompt。
import { it } from 'vitest'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { appendFeedbackSummary, appendScriptInvalid } from '../components/script/prompt-builder.js'

const ROOT = process.cwd()
const RUN_ROUTE_SRC = 'packages/core/src/routes/run.ts'
const RUNNER_SRC = 'packages/client/composables/runner/useRunner.ts'
const ACTIONS_SRC = 'packages/client/components/script/script-panel-actions.ts'

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 造一个「服务端前置拦截」形态的结果 */
function blocked(extra: Record<string, unknown> = {}): Parameters<typeof appendScriptInvalid>[1] {
  return {
    runId: '',
    code: 400,
    ok: false,
    stdout: '',
    stderr: 'HTTP 400 Bad Request\n{"error":"脚本语法错误：Unexpected end of input（前 80 字符：...）","syntaxError":true,"truncated":true}',
    ...extra,
  }
}

it('截断 + 超预算：给出拆小重发的可执行指令，且禁止原地重试', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({
    truncated: true,
    scriptSize: { lines: 480, bytes: 14 * 1024, overBudget: true, maxLines: 300, maxBytes: 12 * 1024 },
  }))
  const text = p.join('\n')
  assert.match(text, /未通过前置校验/)
  assert.match(text, /被上游截断/)
  assert.match(text, /480 行 \/ 14\.0 KB/)
  assert.match(text, /已超预算/)
  assert.match(text, /禁止\*\*重发同样长度/)
  assert.match(text, /拆成多个小脚本/)
  assert.match(text, /串行/)
  assert.match(text, /≤ 150 行/)
  assert.match(text, /只重发\*\*尚未完成\*\*的部分/)
})

it('截断 + 未超预算：提示「恰好卡在安全工作区边缘」，而非误报超预算', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({
    truncated: true,
    scriptSize: { lines: 280, bytes: 11 * 1024, overBudget: false, maxLines: 300, maxBytes: 12 * 1024 },
  }))
  const text = p.join('\n')
  assert.match(text, /未超预算/)
  assert.match(text, /安全工作区边缘/)
  assert.doesNotMatch(text, /已超预算/)
})

it('§10 口径：截断分支的体积账本必须标明「非拦截闸门 / 安全工作区」，不得写成硬上限', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({
    truncated: true,
    scriptSize: { lines: 480, bytes: 14 * 1024, overBudget: true, maxLines: 300, maxBytes: 12 * 1024 },
  }))
  const text = p.join('\n')
  assert.match(text, /§10 安全工作区 300 行 \/ 12 KB，非拦截闸门/)
  assert.doesNotMatch(text, /硬上限|预算上限/)
})

it('截断分支不得出现「重新生成完整脚本」式规劝（那正是原地重试的源头）', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({
    truncated: true,
    scriptSize: { lines: 480, bytes: 14 * 1024, overBudget: true, maxLines: 300, maxBytes: 12 * 1024 },
  }))
  assert.doesNotMatch(p.join('\n'), /重新生成完整脚本/)
})

it('非截断的 4xx（真语法错）：走「修正后重新生成」，不得出现截断措辞', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({
    stderr: 'HTTP 400 Bad Request\n{"error":"脚本语法错误：Unexpected token \'=\'","syntaxError":true,"truncated":false}',
    truncated: false,
  }))
  const text = p.join('\n')
  assert.match(text, /未通过前置校验/)
  assert.match(text, /Unexpected token '='/)
  assert.doesNotMatch(text, /被上游截断/)
  assert.doesNotMatch(text, /拆成多个小脚本/)
  assert.doesNotMatch(text, /≤ 150 行/)
})

it('错误详情从 JSON 响应体里取出，而不是把 HTTP 状态行当原因', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({ truncated: false }))
  const text = p.join('\n')
  assert.match(text, /脚本语法错误：Unexpected end of input/)
  assert.doesNotMatch(text, /HTTP 400/)
})

it('已执行过的轮次（有 runId）不得产出前置拦截块', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({ runId: '1700000000000-abcd' }))
  assert.equal(p.join(''), '')
})

it('运行中途失败（exit 非 4xx）不得产出前置拦截块', () => {
  const p: string[] = []
  appendScriptInvalid(p, blocked({ code: 1 }))
  assert.equal(p.join(''), '')
})

it('null / 无结果时不产出任何块', () => {
  const p: string[] = []
  appendScriptInvalid(p, null)
  assert.equal(p.join(''), '')
})

it('三层反馈摘要：前置拦截时不得报「行为层: 退出码 400」', () => {
  const p: string[] = []
  appendFeedbackSummary(p, blocked({ truncated: true }))
  const text = p.join('\n')
  assert.doesNotMatch(text, /退出码 400/)
  assert.match(text, /未通过前置校验，服务端未执行/)
})

it('三层反馈摘要：真「跑过但退出码非 0」仍须如实报退出码（别把这条也吞了）', () => {
  const p: string[] = []
  appendFeedbackSummary(p, { runId: '1700000000000-abcd', code: 3, ok: false })
  assert.match(p.join('\n'), /行为层: 退出码 3/)
})

// ── 接线结构断言：防「函数写了但没接上」────────────────────────────────────

it('wiring: run.ts 的语法错误 400 必须下发 truncated 与 scriptSize', () => {
  const src = read(RUN_ROUTE_SRC)
  assert.match(src, /syntaxError: true/, '语法错误分支必须仍带 syntaxError 标记')
  assert.match(src, /truncated: syntax\.truncated/, '必须把截断判据下发到客户端，否则客户端只能靠猜')
  assert.match(src, /scriptSize: measureScriptSize\(effectiveScript\)/, '必须下发到达体积，否则无法判断「本轮本来就超预算」')
})

it('wiring: useRunner 必须解析 4xx 响应体并把 truncated/scriptSize 落进 result', () => {
  const src = read(RUNNER_SRC)
  assert.match(src, /parsed\.truncated === true/, '必须从响应体提取 truncated')
  assert.match(src, /parsed\.scriptSize/, '必须从响应体提取 scriptSize')
  assert.match(src, /\.\.\.meta,/, '必须把提取结果并入 result.value，否则后续 prompt 拿不到')
})

it('wiring: buildAiPrompt 必须调用 appendScriptInvalid，且排在源码块之前', () => {
  const src = read(ACTIONS_SRC)
  assert.match(src, /appendScriptInvalid\(p, r\)/, 'buildAiPrompt 未接线：函数写了也白写')
  const callAt = src.indexOf('appendScriptInvalid(p, r)')
  const srcFilesAt = src.indexOf('await appendFailedSourceFiles(')
  assert.ok(callAt > 0 && srcFilesAt > 0)
  assert.ok(callAt < srcFilesAt, '前置拦截块必须最先出现：它是 AI 解读整条消息的前提，压在源码块后会被淹没')
})
