import type { Ref } from 'vue'
import type { InboxItem } from '../../runner/useScriptInbox'
// [cohesion-over-budget-v1] 原此处再导出 InboxItem / Ref，只为让 reply-handlers「不新增 import 语句」
// 以躲开「单文件 import ≤ 8」。上限放宽到 20 后该绕道已无必要，消费方改直连真实来源
// AIRUNNER-BATCH5-0A-TYPES-SPLIT
// 从 useAutoLoop.ts 抽出的类型定义（batch5-0a，HCLC 类型分离）

/** 循环状态（类型别名） */
export type LoopState
  = | 'idle' // 从未开始
    | 'running' // 循环进行中（初始化/发送首轮）
    | 'preparing'
    | 'waiting' // 已 fill，等 AI 回复
    | 'parsing' // 收到脚本，校验中
    | 'executing' // 脚本执行中（cjs /run 或 bash /exec）
    | 'feedback' // 回填结果给 AI
    | 'stopped' // 自然终止（done / 熔断）
    | 'interrupted' // 用户中断（暂停/急停/回滚）
    | 'handoff'
    | 'budget-limited'
    | 'waiting-input' // 决策点（PLAN C.9）
    | 'paused' // 用户主动暂停（区别于 interrupted：可恢复） [loop-state-paused-v1]
    // [loopstate-dedup-v1] 已删重复的 preparing 分支（L9 已定义）

/** 停止（类型别名） */
export type StopRequest = 'none' | 'pause' | 'kill' | 'rollback'

/** AI（接口） */
export interface AiReply {
  // [stopped-detect-v1] stopped = AI 页面「当前问题已停止」，生成被中止（无 DONE/无完整脚本）
  // [limit-detect-v1] limit = AI 会话达到长度上限（应触发轮转新会话）
  kind: 'script' | 'done' | 'plain' | 'multi' | 'stopped' | 'limit'
  /** kind=script 时有效 */
  item?: InboxItem
  /** kind=multi 时：新代码块数量 */
  count?: number
  /** kind=done 时可选携带原 text，用于服务端二次校验 isStrictDone */
  text?: string
}

/** 循环实例（接口） */
export interface LoopInstance {
  state: Ref<LoopState>
  id: Ref<string>
  /** [session-isolation-v1] 循环归属的 AI 会话 id；空串=未绑定（旧油猴不带 sessionId，兼容） */
  sessionId: Ref<string>
  round: Ref<number>
  goal: Ref<string>
  startCommit: Ref<string>
  stopRequest: Ref<StopRequest>
  stopReason: Ref<string>
  lastHash: Ref<string>
  lastExec: Ref<{ lang: string, exit: number, changes: number, durationMs: number } | null>
  waitingStartedAt: Ref<number>
  waitingElapsed: Ref<number>
  roundTimeoutMs: Ref<number>
  pendingRound: Ref<RoundOutcome | null>
  /** [selfcheck-observed-cmds-v1] 本轮循环已产生的 runId 列表（供 DONE 时自检对账 toolLog） */
  runIds: Ref<string[]>
  /** 定时器句柄（非响应式，随实例生命周期） */
  roundTimer: ReturnType<typeof setTimeout> | null
  waitingTicker: ReturnType<typeof setInterval> | null
  handoffTimer: ReturnType<typeof setTimeout> | null
}

// AIRUNNER-BATCH5-0A-TYPES-SPLIT-FIX4: 从 useAutoLoop.ts 迁入
/** 轮次（接口） */
export interface RoundOutcome {
  lang: 'js' | 'cjs' | 'bash'
  desc: string
  exit: number
  ok: boolean
  stdout: string
  stderr: string
  changeCount: number
  changedFiles: string[]
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
}
