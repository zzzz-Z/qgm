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
 *  循环终止改由「轮次上限」（LOOP_HARD_MAX_ROUNDS）负责。
 */
export const LOOP_MAX_ROUNDS = Number.POSITIVE_INFINITY
/** 循环内 token 增量警告阈值（v6 §6.9 第 4 条），独立于会话累计 */
/**
 * 循环内 token 增量熔断阈值：在警告基础上加 10% 缓冲，
 *  容忍 tokenEstimator 的启发式估算误差，避免误熔断
 */
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
/** 单轮等待 AI 回复超时（v6 §6.9 第 7 条）—— cjs 默认 90s */
export const LOOP_ROUND_TIMEOUT_MS = 90_000
/** bash 任务单轮超时：bash 通常更复杂，给 180s */
export const LOOP_ROUND_TIMEOUT_BASH_MS = 180_000
/** 回填给 AI 的输出尾部截断长度（v6 §6.5） */

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

/** [L4] 连续 N 轮零变更判定为停滞 */

/** [L4b] 相同指纹连续 N 轮未变则停循环转诊断 */

/** 指纹数组转稳定键（file:line:symbol 排序后拼接） */

/** 相同指纹连续累加判定 */

/**
 * 校验 Round Break
 * @param round - round
 * @param tokenDelta - token Delta
 * @param maxRounds - max Rounds
 */

/** [L4] 每轮结束时更新停滞计数：有变更归零，无变更累加 */

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

// 首轮 prompt：目标 + 输出契约（与 SYSTEM.md §1 对齐）
// 契约文案：普通模式 DONE + 总结；牛马模式禁止 DONE
/** 行集合 */
const CONTRACT_LINES = [
  '',
  '【输出契约（必须严格遵守）】',
  '1. 每次只回复一个代码块，语言标签只能是 js（cjs 兼容）',
  '2. 首行 shebang 必须为 #! /usr/bin/env node；紧接 // @desc 与 // @why 注释',
  '3. 脚本内禁止出现三个反引号；禁止 rm -rf/sudo/curl|sh/git push -f/git reset --hard 等破坏性命令',
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
