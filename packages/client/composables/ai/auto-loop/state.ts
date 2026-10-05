import { computed, ref } from 'vue'
// [state-extract-v1] useAutoLoop 的模块级状态集中地；由 useAutoLoop.ts 导入 + re-export
// 单例：全局一份，供循环状态机 + 反向依赖模块（handoff/keyboard）共享

import { LOOP_ROUND_TIMEOUT_MS } from '../loopLogic.js'
import type { LoopInstance, LoopState, RoundOutcome, StopRequest } from './types.js'

// [selfcheck-observed-cmds-v1] 本轮循环已产生的 runId 列表（供 DONE 时自检对账 toolLog）
export const loopRunIds = ref<string[]>([])
/** 循环状态 */
export const loopState = ref<LoopState>('idle')
/** 循环标识 */
export const loopId = ref('')
/** [session-isolation-v1] 循环归属的 AI 会话 id；空串=未绑定（旧油猴不带 sessionId，兼容） */
export const loopSessionId = ref('')
/** 循环轮次 */
export const loopRound = ref(0)
/** 循环目标 */
export const loopGoal = ref('')
/** 用户备注（随反馈带给 AI） */
export const userNote = ref('')
/** 决策点（ScriptPanel 消费） */
export const pendingDecision = ref<{ question: string, options: Array<{ id: string, label: string }> } | null>(null)
/** 阶段 */
export const stage = ref<'' | 'plan' | 'implement' | 'verify'>('')
/** 循环启动 commit */
export const loopStartCommit = ref('')
/** 停止请求 */
export const stopRequest = ref<StopRequest>('none')
/** 停止原因 */
export const stopReason = ref('')
/** 最后一个哈希 */
export const lastHash = ref('')
/** 最近一次执行摘要，供 UI/反馈使用 */
export const lastExec = ref<{ lang: string, exit: number, changes: number, durationMs: number } | null>(null)
/** 当前轮等待起始时间戳（用于 UI 倒计时进度反馈） */
export const waitingStartedAt = ref(0)
/** 已等待秒数（每秒更新，UI 读取展示） */
export const waitingElapsed = ref(0)
/** 当前轮超时毫秒（根据上一轮 lang 决定，bash=180s / cjs=90s） */
export const roundTimeoutMs = ref(LOOP_ROUND_TIMEOUT_MS)

/** 单例视图：把模块级 ref 包装成 LoopInstance 形状的静态对象 */
export const singletonView: LoopInstance = {
  state: loopState,
  id: loopId,
  sessionId: loopSessionId,
  round: loopRound,
  goal: loopGoal,
  startCommit: loopStartCommit,
  stopRequest,
  stopReason,
  lastHash,
  lastExec,
  waitingStartedAt,
  waitingElapsed,
  roundTimeoutMs,
  runIds: loopRunIds,
  pendingRound: ref<RoundOutcome | null>(null),
  roundTimer: null,
  waitingTicker: null,
  handoffTimer: null,
}

/** 当前激活循环实例（单例视图，computed 维持响应式依赖） */
export const activeLoop = computed<LoopInstance | null>(() => singletonView)

// [state-extract-v2] useAutoLoop 内剩余纯状态归入
/** 页面标题备份（循环启动时记录，结束后恢复） */
export const originalTitle = ref('')
/** 计划续跑最大尝试次数（避免 PLAN 一直 pending 永不停止） */
export const PLAN_RESUME_MAX = 3
/** 计划续跑连续计数（放行 DONE 时归零） */
export const planResumeAttempts = ref(0)
