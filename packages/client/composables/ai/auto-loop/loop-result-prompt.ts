// [loop-feedback-authority-v1] R1：循环引擎的结果回传 prompt
// [WHY] 循环模式下结果回传权归循环引擎，不再依赖 ScriptPanel watch 的 shouldAutoAsk——
//   后者在多脚本批量/暂停场景下漏发或双发，是「批量停摆」的根因
// [CONSTRAINT] 纯函数；不含 transport 依赖，便于单测与复用
//   本模块是「循环向 AI 回传的 prompt」唯一产地（执行结果 / 自检失败 / PLAN 续跑三类）。
//   [plan-selfcheck-prompt-move-v1] 原本后两者散在 reply-handlers.ts 的闭包里；
//   为满足 §4 文件体积 ratchet（reply-handlers.ts 426 行冻结、只减不增）而就近上收。
// [CHANGE-IMPACT] reply-handlers.ts 改为从本模块导入；移出方不得再各自保留副本。
import type { RoundOutcome } from './types.js'

/**
 * 单个块的正文（不含收尾句）
 * [WHY] 合并回传要把 N 块拼成一条，收尾句只留一份；本函数是「单块」与「多块」共用的唯一正文产地，
 *   保证单块路径与逐块时代**逐字相同**（回归红线，见 buildLoopResultPrompt）
 * [CONSTRAINT] 必含 desc / 状态 / exit / 变更数；stderr 截尾 500 字符
 */
function blockBody(outcome: RoundOutcome): string {
  const status = outcome.ok ? '成功' : '失败'
  const desc = outcome.desc || '（无描述）'
  const files = outcome.changedFiles.length
    ? `\n变更文件：\n${outcome.changedFiles.map(f => `- ${f}`).join('\n')}`
    : '\n（无文件变更）'
  const tail = outcome.stderr ? `\n错误摘要：\n${outcome.stderr.slice(-500)}` : ''
  return `【本轮执行结果】${desc}\n状态：${status} · exit=${outcome.exit} · 变更 ${outcome.changeCount} 个文件${files}${tail}`
}

/**
 * 组装「本轮执行结果」prompt，供循环引擎 sendFill 回传给 AI
 * [CONSTRAINT] 文本与 [loop-feedback-authority-v1] 引入时逐字相同（单块回归红线）
 * @param outcome 本轮执行结果（由 executeItemInner 构造）
 */
export function buildLoopResultPrompt(outcome: RoundOutcome): string {
  return `${blockBody(outcome)}\n请阅读终端输出。下一个回答必须以 SCRIPT 开头且只输出脚本，不要输出任何文本总结。`
}

/** 拒收/失败分桶标签（无分桶价值时返回空串） */
const REJECT_BUCKETS: Array<{ re: RegExp, label: string }> = [
  // 取值来自真实拒收链路（run.ts 的 400 响应体 → useRunner 把它摊进 stderr）：
  //   head-contract ⇒ `{"error":"脚本头契约违规：MISSING_DESC|MISSING_WHY|ILLEGAL_SHEBANG: …"}`
  //   syntax        ⇒ `{"error":"脚本语法错误：…","truncated":true|false}`
  //   empty         ⇒ `{"error":"脚本为空"}`
  // 顺序即优先级：更具体的在前（先判截断，否则 `Unexpected end of input` 会被算成普通语法错误）
  { re: /MISSING_DESC/, label: '缺 @desc' },
  { re: /MISSING_WHY/, label: '缺 @why' },
  { re: /ILLEGAL_SHEBANG/, label: 'shebang 非法' },
  { re: /脚本为空/, label: '空脚本' },
  { re: /"truncated":true|Unexpected end of input|截断/, label: '语法+截断' },
  { re: /脚本语法错误|SyntaxError|Unexpected token/, label: '语法错误' },
]

/**
 * 把一次失败归到可读短桶名；成功返回空串
 * [WHY] 合并回传后 AI 只看到一条汇总，必须能在文案里读到「这批错在哪一类、各几次」，
 *   否则它只能猜（原先逐条回传时每条都带原文，合并后就丢了——P0-3 ①）
 */
export function classifyRoundFailure(outcome: RoundOutcome): string {
  if (outcome.ok) return ''
  const s = `${outcome.stderr || ''}\n${outcome.stdout || ''}`
  const hit = REJECT_BUCKETS.find(b => b.re.test(s))
  return hit ? hit.label : '执行失败'
}

/**
 * 组装「本回复多块结果」合并 prompt —— 一条回复含 N 块时只回传一次（N 块 1 次，而非 N 次）
 * [WHY] 逐块回传会把 AI 唤醒 N-1 次，是站点限流的第一放大器；而「块已执行完但下一块尚未推送」
 *   （页面侧逐块推送、块间 80ms）时，队列为空这一判据不成立 —— 故改由轮内合并窗收口。
 * [CONSTRAINT] 单块必须走 buildLoopResultPrompt 原样返回（回归红线，逐字等价）
 * @param outcomes 本回复内按执行顺序累积的全部块结果
 */
export function buildRoundBatchPrompt(outcomes: RoundOutcome[]): string {
  if (outcomes.length === 0) return ''
  if (outcomes.length === 1) return buildLoopResultPrompt(outcomes[0])
  const okCount = outcomes.filter(o => o.ok).length
  const buckets = new Map<string, number>()
  for (const o of outcomes) {
    const label = classifyRoundFailure(o)
    if (label) { buckets.set(label, (buckets.get(label) || 0) + 1) }
  }
  const bucketLine = buckets.size
    ? `\n失败分桶：${[...buckets].map(([k, v]) => `${k} ×${v}`).join(' · ')}`
    : ''
  const blocks = outcomes
    .map((o, i) => `── 块 ${i + 1}/${outcomes.length} ──\n${blockBody(o)}`)
    .join('\n')
  return `【本轮执行结果】本回复共 ${outcomes.length} 块（成功 ${okCount} · 失败 ${outcomes.length - okCount}）${bucketLine}\n${blocks}\n请阅读终端输出。下一个回答必须以 SCRIPT 开头且只输出脚本，不要输出任何文本总结。`
}

/**
 * 组装自检失败报告（AI 照单修）
 * [CONSTRAINT] 固定格式 [SELF-FAIL] <级别> | <判据> | 实测值 | 期望值
 */
export function buildSelfcheckFailPrompt(reason: string): string {
  const lines = String(reason || '').split('\n').map(s => s.trim()).filter(Boolean)
  const body = lines.length ? lines.join('\n') : '[SELF-FAIL] L0 | selfcheck | 自检未通过 | 全部通过'
  return `【自检未通过】请修复以下判据后重新回复 DONE：\n${body}`
}

/** 组装 PLAN 续跑 prompt：必须携带具体剩余项（AI 页面上下文里没有本地 PLAN.md） */
export function buildPlanResumePrompt(items: string[]): string {
  const lines = items.map((d, i) => `${i + 1}. ${d}`).join('\n')
  return `【继续】长期计划仍有 ${items.length} 项未完成：\n${lines}\n请针对下一项输出一个可执行脚本（遵守脚本头契约）；这些项全部完成后才回复 DONE。`
}
