// [interaction-log-v1] 交互记录器：把用户对循环的所有动作写进 trace 时间轴。
// 契约：只做记录，不改变任何循环行为；trace 是唯一落点，不新建存储。
import { useTraceLog } from '../ui/useTraceLog.js'

/** 用户动作枚举 */
export type UserAction
  = | 'pause' // 软暂停（当前轮完成即停）
    | 'resume' // 从暂停恢复
    | 'kill' // 急停（终止循环）
    | 'rollback' // 回滚（终止 + 还原变更）
    | 'takeover-on' // 开启自动接管
    | 'takeover-off' // 关闭自动接管
    | 'send' // 手动点「发送」
    | 'exit-pause' // 从暂停回待发

/** 触发来源 */
export type UserSource = 'keyboard' | 'button' | 'auto'

const LABELS: Record<UserAction, string> = {
  'pause': '暂停',
  'resume': '恢复',
  'kill': '急停',
  'rollback': '回滚',
  'takeover-on': '开启接管',
  'takeover-off': '关闭接管',
  'send': '发送',
  'exit-pause': '退出暂停',
}

/**
 * 记录一次用户交互动作。
 * @param action - 动作标识
 * @param source - 触发来源（keyboard / button / auto）
 * @param extra - 附加信息（写入 payload.detail）
 */
export function recordInteraction(action: UserAction, source: UserSource, extra?: Record<string, unknown>): void {
  try {
    const { addTrace } = useTraceLog()
    addTrace({
      kind: 'user',
      summary: `[用户] ${LABELS[action] || action}`,
      payload: {
        userAction: action,
        userSource: source,
        ...(extra || {}),
      },
    })
  } catch { /* 记录失败不阻断业务 */ }
}
