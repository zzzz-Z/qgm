// ============================================================================
// loopLogic —— 自动化循环的纯决策逻辑
// 不依赖 vue / DOM / sessionStorage，可在 node:test 下直接单测。
// useAutoLoop 是「有状态的编排者」，本模块是「无状态的判定规则」。
// 修改熔断参数/判定规则只需改这里，行为被 loopLogic.node-test.ts 锁定。
// ============================================================================

/**
 * [drop-round-limit] 轮次上限已取消；保留常量名兼容引用，值 Infinity 表示无上限。
 *  循环终止改由「轮次上限」（LOOP_HARD_MAX_ROUNDS）负责。
 */
export const LOOP_MAX_ROUNDS = Number.POSITIVE_INFINITY
/**
 * [loop-hard-limit-v1] 循环硬上限：防止"一直发不停"
 * 双上限先到者触发 finish('hard-timeout' | 'hard-rounds')
 */
export const LOOP_HARD_MAX_MS = 30 * 60 * 1000
/** [loop-hard-limit-v1] 循环最大轮次硬上限 */
export const LOOP_HARD_MAX_ROUNDS = 50
/** [fix-rotate-threshold] 循环内 token 达此值触发会话轮转（独立于熔断） */
export const LOOP_ROTATE_THRESHOLD = 40_000
/** 单轮等待 AI 回复超时 —— cjs 默认 90s */
export const LOOP_ROUND_TIMEOUT_MS = 90_000
/** bash 任务单轮超时：bash 通常更复杂，给 180s */
export const LOOP_ROUND_TIMEOUT_BASH_MS = 180_000

// DONE 严格识别
// 必须整段 trim 后恰为 DONE；防止「this task is done」「DONE！」误判终止。
// 关键：DONE 必须独占一行，前后不允许出现其他可打印字符；
// 仅允许前后空白/换行（^\s* 与 \s*$）。多行文本中夹带 DONE 不算终止信号。
/**
 * 判断首行是否为严格的 DONE 标记
 * [WHY] 允许多行：首行 DONE，第二行起可跟总结（[done-with-summary] 归档用）
 * [CONSTRAINT] 首行 trim 后必须恰为 DONE；'DONE!' / 'Task done' / '已完成' 均不识别
 */
export function isStrictDone(text: string): boolean {
  // 默认模式 ^/$ 不跨行，'DONE\nDONE' 不匹配；'DONE\n' 仍可匹配（\n 属 \s）
  // [done-with-summary] 首行严格 DONE；第二行起允许总结（用于归档）
  const s = String(text ?? '')
  const firstNonEmpty = s.split(/\r?\n/).find(l => l.trim().length > 0) ?? ''
  return /^\s*DONE\s*$/.test(firstNonEmpty)
}

// 文本工具

// 格式不符时的重试 prompt（宽容预算内唯一一次重试）
/**
 * 构建格式重试 prompt（宽容预算内唯一一次）
 * [WHY] 明确告知 AI 失败原因并允许其声明 DONE，避免格式错误被误解为任务未完成
 * [CONSTRAINT] detail 应简短单行（会拼进 prompt 首行）
 * @param detail 上一轮格式不符的原因
 */
export function buildRetryPrompt(detail: string): string {
  return [
    `【格式不符，重试一次】${detail}。`,
    '若任务实际已完成，请只回复 DONE。',
  ].join('\n')
}
