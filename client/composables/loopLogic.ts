// ============================================================================
// loopLogic —— 自动化循环的纯决策逻辑（v6 §6）
// 不依赖 vue / DOM / sessionStorage，可在 node:test 下直接单测。
// useAutoLoop 是「有状态的编排者」，本模块是「无状态的判定规则」。
// 修改熔断参数/判定规则只需改这里，行为被 loopLogic.node-test.ts 锁定。
// ============================================================================

/** 循环最大轮数（v6 §6.9 第 3 条） */
export const LOOP_MAX_ROUNDS = 8
/** 循环内 token 增量警告阈值（v6 §6.9 第 4 条），独立于会话累计 */
export const LOOP_TOKEN_BUDGET = 30_000
/** 循环内 token 增量熔断阈值：在警告基础上加 10% 缓冲，
 *  容忍 tokenEstimator 的启发式估算误差，避免误熔断 */
export const LOOP_TOKEN_HARD_LIMIT = 33_000
/** 宽容预算：格式错误 OR 纯文本 OR 重复脚本共享（v6 §6.9 第 2 条） */
export const LOOP_TOLERANCE_BUDGET = 1
/** 单轮等待 AI 回复超时（v6 §6.9 第 7 条）—— cjs 默认 90s */
export const LOOP_ROUND_TIMEOUT_MS = 90_000
/** bash 任务单轮超时：bash 通常更复杂，给 180s */
export const LOOP_ROUND_TIMEOUT_BASH_MS = 180_000
/** 回填给 AI 的输出尾部截断长度（v6 §6.5） */
export const LOOP_FEEDBACK_TAIL = 3000

// ----------------------------------------------------------------------------
// DONE 严格识别（v6 §6.9 第 1 条）
// 必须整段 trim 后恰为 DONE；防止「this task is done」「DONE！」误判终止。
// 关键：DONE 必须独占一行，前后不允许出现其他可打印字符；
// 仅允许前后空白/换行（^\s* 与 \s*$）。多行文本中夹带 DONE 不算终止信号。
// ----------------------------------------------------------------------------
export function isStrictDone(text: string): boolean {
  // 默认模式 ^/$ 不跨行，'DONE\nDONE' 不匹配；'DONE\n' 仍可匹配（\n 属 \s）
  return /^\s*DONE\s*$/.test(String(text ?? ''))
}

// ----------------------------------------------------------------------------
// 轮后熔断判定：在「一轮已成功执行完、准备进入下一轮」前调用
// 优先级与历史实现保持一致：token 熔断 > token 警告 > 轮数上限
// 区分 token-warn（30k，UI 提示继续）与 token-budget（33k，熔断暂停）
// ----------------------------------------------------------------------------
export type RoundBreak = 'round-limit' | 'token-budget' | 'token-warn' | 'continue'

export function checkRoundBreak(round: number, tokenDelta: number): RoundBreak {
  if (Math.max(0, tokenDelta) >= LOOP_TOKEN_HARD_LIMIT) return 'token-budget'
  if (Math.max(0, tokenDelta) >= LOOP_TOKEN_BUDGET) return 'token-warn'
  if (round >= LOOP_MAX_ROUNDS) return 'round-limit'
  return 'continue'
}

// ----------------------------------------------------------------------------
// 宽容预算判定：返回「重试（消耗一次）」或「熔断」
// ----------------------------------------------------------------------------
export type ToleranceResult =
  | { action: 'retry', remaining: number }
  | { action: 'break' }

export function decideTolerance(leftBefore: number): ToleranceResult {
  if (leftBefore > 0) return { action: 'retry', remaining: leftBefore - 1 }
  return { action: 'break' }
}

// ----------------------------------------------------------------------------
// 文本工具
// ----------------------------------------------------------------------------

/** 只保留尾部 max 字符（执行输出可能很长，回填只给尾部上下文） */
export function tailClip(text: string, max: number = LOOP_FEEDBACK_TAIL): string {
  const s = String(text ?? '')
  return s.length > max ? s.slice(-max) : s
}

// ----------------------------------------------------------------------------
// 首轮 prompt：目标 + 输出契约（与 skills/gen-script-rules.md 第七节一致）
// ----------------------------------------------------------------------------
export function buildInitialPrompt(goal: string): string {
  return String(goal).trim() + '\n' + [
    '',
    '【输出契约（必须严格遵守）】',
    '1. 每次只回复一个代码块，语言标签只能是 js 或 bash（cjs 兼容，等价 js）',
    '2. 首行 shebang：js 用 #!/usr/bin/env node，bash 用 #!/usr/bin/env bash；紧接 //（或 #）@desc 与 @why 注释',
    '3. 脚本内禁止出现三个反引号；bash 禁止 rm -rf/sudo/curl|sh/git push -f/git reset --hard 等破坏性命令',
    '4. 每轮必须推进，禁止重复上一轮脚本',
    `5. 最多 ${LOOP_MAX_ROUNDS} 轮；任务完成时只回复 DONE（严格大写、无其他字符）`,
  ].join('\n')
}

// ----------------------------------------------------------------------------
// 格式不符时的重试 prompt（宽容预算内唯一一次重试）
// ----------------------------------------------------------------------------
export function buildRetryPrompt(detail: string): string {
  return [
    `【格式不符，重试一次】${detail}。`,
    '请重新输出：且仅输出一个 ```js 或 ```bash 代码块，首行 shebang，紧接 @desc/@why 注释。',
    '若任务实际已完成，请只回复 DONE。',
  ].join('\n')
}

// ----------------------------------------------------------------------------
// 轮后回填：把执行结果结构化回喂给 AI（v6 §6.5）
// ----------------------------------------------------------------------------
export interface FeedbackOutcome {
  lang: 'js' | 'cjs' | 'bash'
  desc: string
  exit: number
  ok: boolean
  stdout: string
  stderr: string
  changeCount: number
  changedFiles: string[]
}

export interface FeedbackContext {
  /** 即将进入的轮次（当前轮 + 1） */
  nextRound: number
  /** 循环内 token 增量 */
  tokenDelta: number
}

export function buildFeedback(o: FeedbackOutcome, ctx: FeedbackContext): string {
  const lines: string[] = [
    '【上轮执行结果】',
    `类型: ${o.lang}`,
    o.desc ? `说明: ${o.desc}` : '',
    `退出码: ${o.exit}（${o.ok ? '成功' : '失败'}）`,
    o.lang !== 'bash'
      ? `变更: ${o.changeCount} 个文件${o.changedFiles.length ? '：' + o.changedFiles.slice(0, 10).join(', ') : ''}`
      : '',
    o.stdout ? `输出(尾 ${LOOP_FEEDBACK_TAIL} 字):\n${tailClip(o.stdout)}` : '',
    o.stderr ? `错误(尾 ${LOOP_FEEDBACK_TAIL} 字):\n${tailClip(o.stderr)}` : '',
    '',
    `请继续（第 ${ctx.nextRound}/${LOOP_MAX_ROUNDS} 轮，循环内 token 已用约 ${(Math.max(0, ctx.tokenDelta) / 1000).toFixed(1)}k/${LOOP_TOKEN_BUDGET / 1000}k，熔断线 ${LOOP_TOKEN_HARD_LIMIT / 1000}k）。`,
    '若任务已完成，只回复 DONE；否则输出且仅输出一个 cjs/bash 代码块，必须推进，勿重复上轮脚本。',
  ]
  return lines.join('\n')
}
