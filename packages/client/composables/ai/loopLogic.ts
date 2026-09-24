// ============================================================================
// loopLogic —— 自动化循环的纯决策逻辑（v6 §6）
// 不依赖 vue / DOM / sessionStorage，可在 node:test 下直接单测。
// useAutoLoop 是「有状态的编排者」，本模块是「无状态的判定规则」。
// 修改熔断参数/判定规则只需改这里，行为被 loopLogic.node-test.ts 锁定。
// ============================================================================

/** 循环最大轮数（v6 §6.9 第 3 条） */
interface FingerprintLite { file: string, line: number, symbol: string, kind?: string }

/**
 * [drop-round-limit] 轮次上限已取消；保留常量名兼容引用，值 Infinity 表示无上限。
 *  循环终止改由「无进展刹车」（LOOP_STALL_LIMIT）与 token 熔断负责。
 */
export const LOOP_MAX_ROUNDS = Number.POSITIVE_INFINITY
/** 循环内 token 增量警告阈值（v6 §6.9 第 4 条），独立于会话累计 */
export const LOOP_TOKEN_BUDGET = 30_000
/**
 * 循环内 token 增量熔断阈值：在警告基础上加 10% 缓冲，
 *  容忍 tokenEstimator 的启发式估算误差，避免误熔断
 */
export const LOOP_TOKEN_HARD_LIMIT = 33_000
/**
 * [loop-hard-limit-v1] 循环硬上限：即使牛马模式也生效，防止"一直发不停"
 * 双上限先到者触发 finish('hard-timeout' | 'hard-rounds')
 */
export const LOOP_HARD_MAX_MS = 30 * 60 * 1000
/** [loop-hard-limit-v1] 循环最大轮次硬上限 */
export const LOOP_HARD_MAX_ROUNDS = 50
/** [fix-rotate-threshold] 循环内 token 达此值触发会话轮转（独立于熔断） */
export const LOOP_ROTATE_THRESHOLD = 40_000
/** 宽容预算：格式错误 OR 纯文本 OR 重复脚本共享（v6 §6.9 第 2 条） */
export const LOOP_TOLERANCE_BUDGET = 1
/** 单轮等待 AI 回复超时（v6 §6.9 第 7 条）—— cjs 默认 90s */
export const LOOP_ROUND_TIMEOUT_MS = 90_000
/** bash 任务单轮超时：bash 通常更复杂，给 180s */
export const LOOP_ROUND_TIMEOUT_BASH_MS = 180_000
/** 回填给 AI 的输出尾部截断长度（v6 §6.5） */
export const LOOP_FEEDBACK_TAIL = 3000

// DONE 严格识别（v6 §6.9 第 1 条）
// 必须整段 trim 后恰为 DONE；防止「this task is done」「DONE！」误判终止。
// 关键：DONE 必须独占一行，前后不允许出现其他可打印字符；
// 仅允许前后空白/换行（^\s* 与 \s*$）。多行文本中夹带 DONE 不算终止信号。
/**
 * 判断是否为 Strict Done
 * @param text - text
 */
export function isStrictDone(text: string): boolean {
  // 默认模式 ^/$ 不跨行，'DONE\nDONE' 不匹配；'DONE\n' 仍可匹配（\n 属 \s）
  // [done-with-summary] 首行严格 DONE；第二行起允许总结（用于归档）
  const s = String(text ?? '')
  const firstNonEmpty = s.split(/\r?\n/).find(l => l.trim().length > 0) ?? ''
  return /^\s*DONE\s*$/.test(firstNonEmpty)
}

// 轮后熔断判定：在「一轮已成功执行完、准备进入下一轮」前调用
// 优先级与历史实现保持一致：token 熔断 > token 警告 > 轮数上限
// 区分 token-warn（30k，UI 提示继续）与 token-budget（33k，熔断暂停）
/** 轮次（类型别名） */
export type RoundBreak = 'round-limit' | 'token-budget' | 'token-warn' | 'no-progress' | 'continue'

/** [L4] 连续 N 轮零变更判定为停滞 */
export const LOOP_STALL_LIMIT = 3

/** [L4b] 相同指纹连续 N 轮未变则停循环转诊断 */
export const LOOP_FP_STALL_LIMIT = 2

/** 指纹数组转稳定键（file:line:symbol 排序后拼接） */
export function fpKey(fp?: FingerprintLite[]): string {
  if (!fp || !fp.length) return ''
  return fp.map((f) => { return `${f.file}:${f.line}:${f.symbol}` }).sort().join('|')
}

/** 相同指纹连续累加判定 */
export function updateFpStall(prevKey: string, currKey: string, count: number): { stalled: boolean, next: number } {
  if (!currKey) return { stalled: false, next: 0 }
  if (prevKey === currKey) {
    const next = count + 1
    return { stalled: next >= LOOP_FP_STALL_LIMIT, next }
  }
  return { stalled: false, next: 0 }
}

/**
 * 校验 Round Break
 * @param round - round
 * @param tokenDelta - token Delta
 * @param maxRounds - max Rounds
 */
export function checkRoundBreak(round: number, tokenDelta: number, maxRounds: number = LOOP_MAX_ROUNDS): RoundBreak {
  if (Math.max(0, tokenDelta) >= LOOP_TOKEN_HARD_LIMIT) return 'token-budget'
  if (Math.max(0, tokenDelta) >= LOOP_TOKEN_BUDGET) return 'token-warn'
  if (round >= maxRounds) return 'round-limit'
  return 'continue'
}

/** [L4] 每轮结束时更新停滞计数：有变更归零，无变更累加 */
export function updateStall(changeCount: number, stallCount: number): { stalled: boolean, next: number } {
  const next = changeCount > 0 ? 0 : stallCount + 1
  return { stalled: next >= LOOP_STALL_LIMIT, next }
}

// 宽容预算判定：返回「重试（消耗一次）」或「熔断」
type ToleranceResult
  = | { action: 'retry', remaining: number }
    | { action: 'break' }

/**
 * 执行 decide Tolerance
 * @param leftBefore - left Before
 */
export function decideTolerance(leftBefore: number): ToleranceResult {
  if (leftBefore > 0) return { action: 'retry', remaining: leftBefore - 1 }
  return { action: 'break' }
}

// 文本工具

/** 只保留尾部 max 字符（执行输出可能很长，回填只给尾部上下文） */
export function tailClip(text: string, max: number = LOOP_FEEDBACK_TAIL): string {
  const s = String(text ?? '')
  return s.length > max ? s.slice(-max) : s
}

// 首轮 prompt：目标 + 输出契约（与 skills/gen-script-rules.md 第七节一致）
// 契约文案：普通模式 DONE + 总结；牛马模式禁止 DONE
/** 行集合 */
const CONTRACT_LINES = [
  '',
  '【输出契约（必须严格遵守）】',
  '1. 每次只回复一个代码块，语言标签只能是 js 或 bash（cjs 兼容，等价 js）',
  '2. 首行 shebang：js 用 #!/usr/bin/env node，bash 用 #!/usr/bin/env bash；紧接 //（或 #）@desc 与 @why 注释',
  '3. 脚本内禁止出现三个反引号；bash 禁止 rm -rf/sudo/curl|sh/git push -f/git reset --hard 等破坏性命令',
  '4. 每轮必须推进，禁止重复上一轮脚本',
]

/** 契约中的 DONE 标记行文本 */
// [done-contract-v2] 强制首行只写 DONE，列举禁止变体，降低 isStrictDone 漏判
const CONTRACT_DONE_LINE = [
  '5. 任务完成时，回复格式必须严格如下：',
  '   第 1 行：只写 DONE 三个大写字母（无标点、无前后缀、无缩进、无引号）',
  '   第 2 行起：用 markdown 总结（完成了什么 / 解决了什么 / 遇到的问题）',
  '   禁止写：完成 / DONE！ / DONE. / Task done / 已完成 / all done / 收工',
  '   违反格式会导致循环无法识别完成信号而持续发消息。',
].join('\n')

/** 契约中的牛马模式标记行文本 */
const CONTRACT_NIUMA_LINE = '5. 牛马模式：禁止输出 DONE；持续输出下一个可执行脚本推进项目优化，永不停下'

/**
 * 构建 Session Prompt
 * @param niuma - niuma
 */
export function buildSessionPrompt(niuma: boolean = false): string {
  return [
    '【新会话启动 · 默认提示词】请按输出契约继续工作，等待用户指定任务。',
    ...CONTRACT_LINES,
    niuma ? CONTRACT_NIUMA_LINE : CONTRACT_DONE_LINE,
  ].join('\n')
}

/** 会话 */
export const DEFAULT_SESSION_PROMPT = buildSessionPrompt(false)

/**
 * 构建 Initial Prompt
 * @param goal - goal
 * @param niuma - niuma
 */
export function buildInitialPrompt(goal: string, niuma: boolean = false): string {
  return `${String(goal).trim()}\n${[
    ...CONTRACT_LINES,
    niuma ? CONTRACT_NIUMA_LINE : CONTRACT_DONE_LINE,
  ].join('\n')}`
}

// 格式不符时的重试 prompt（宽容预算内唯一一次重试）
/**
 * 构建 Retry Prompt
 * @param detail - detail
 */
export function buildRetryPrompt(detail: string): string {
  return [
    `【格式不符，重试一次】${detail}。`,
    '若任务实际已完成，请只回复 DONE。',
  ].join('\n')
}

// 轮后回填：把执行结果结构化回喂给 AI（v6 §6.5）
/** 反馈轮结果：是否继续 + 下一轮动作 */
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

interface FeedbackContext {
  /** 即将进入的轮次（当前轮 + 1） */
  nextRound: number
  /** 循环内 token 增量 */
  tokenDelta: number
  /** 循环目标（用于记忆锚点） */
  goal?: string
  /** 当前已完成轮次 */
  round?: number
  /** 最大轮数 */
  max?: number
  /** 用户补充说明 */
  userNote?: string
}

/**
 * 构建 Feedback
 * @param o - o
 * @param ctx - ctx
 */
export function buildFeedback(o: FeedbackOutcome, ctx: FeedbackContext): string {
  const max = ctx.max ?? LOOP_MAX_ROUNDS
  const anchorLines: string[] = []
  if (ctx.goal) {
    const capped = Number.isFinite(max)
    const remain = capped ? Math.max(0, max - (ctx.round ?? 0)) : 0
    anchorLines.push(capped
      ? `【锚】目标：${ctx.goal.slice(0, 40)} | 进度 ${ctx.round ?? 0}/${max} | 剩 ${remain} 轮`
      : `【锚】目标：${ctx.goal.slice(0, 40)} | 进度 ${ctx.round ?? 0} 轮（无上限）`)
    anchorLines.push('')
  }
  if (ctx.userNote) {
    anchorLines.push(`【用户补充】${ctx.userNote}`)
    anchorLines.push('')
  }
  const lines: string[] = [
    ...anchorLines,
    '【上轮执行结果】',
    `类型: ${o.lang}`,
    o.desc ? `说明: ${o.desc}` : '',
    `退出码: ${o.exit}（${o.ok ? '成功' : '失败'}）`,
    o.lang !== 'bash'
      ? `变更: ${o.changeCount} 个文件${o.changedFiles.length ? `：${o.changedFiles.slice(0, 10).join(', ')}` : ''}`
      : '',
    o.stdout ? `输出(尾 ${LOOP_FEEDBACK_TAIL} 字):\n${tailClip(o.stdout)}` : '',
    o.stderr ? `错误(尾 ${LOOP_FEEDBACK_TAIL} 字):\n${tailClip(o.stderr)}` : '',
    '',
    `请继续（第 ${ctx.nextRound} 轮，循环内 token 已用约 ${(Math.max(0, ctx.tokenDelta) / 1000).toFixed(1)}k/${LOOP_TOKEN_BUDGET / 1000}k，熔断线 ${LOOP_TOKEN_HARD_LIMIT / 1000}k）。`,
    '若任务已完成，只回复 DONE；否则输出且仅输出一个 cjs/bash 代码块，必须推进，勿重复上轮脚本。',
  ]
  return lines.join('\n')
}
