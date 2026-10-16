// [reply-toasts-v1] AI 回复相关的 toast 通知层：从 useAiReplyHandlers 抽出，消减该文件的 import 数
//   （§4 单文件唯一 import ≤ 20；抽取前 21 项超红线）。
// [CONSTRAINT] 本文件只做「展示」，不持有任何跨轮状态（stoppedAtBySid 等仍留在原文件，
//   避免把状态机拆散到两个文件——§4「拆分的唯一依据是职责边界」）。
import { useToast } from '../ui/useToast'
import { formatLimitToast } from '../../utils/limit-notice'
import { formatStopToast, STOPPED_SCRIPT_HINT } from '../../utils/stop-notice'
import { TOAST_LONG, TOAST_LONGEST, TOAST_MEDIUM } from '../../utils/toast-durations'

const { toast } = useToast()

/** 站点侧错误（ai-runner:reply kind=error）：AI 网页自身报错 */
export function notifySiteError(text: string): void {
  toast(`DeepSeek 暂时无法回复：${text || '站点返回错误'}`, 'error', TOAST_LONGEST)
}

/** 页面侧命中停止词：带命中原文便于定位误报源（口径同触顶的 formatLimitToast） */
export function notifyStopped(raw: unknown): void {
  toast(formatStopToast(raw), 'warn', TOAST_LONG)
}

/** AI 会话达到长度上限：提示手动开新会话（附带页面侧命中原文） */
export function notifyLimit(raw: unknown): void {
  toast(formatLimitToast(raw), 'warn', TOAST_LONGEST)
  toast('请手动开启新会话后重试', 'info', TOAST_MEDIUM)
}

/** 停止后残余脚本：只回填编辑器、未自动执行 */
export function notifyStoppedScriptHint(): void {
  toast(STOPPED_SCRIPT_HINT, 'warn', TOAST_LONG)
}

/** 等待执行超时：提示手动点击运行 */
export function notifyWaitTimeout(): void {
  toast('等待执行超时（20s），请手动点击运行', 'warn', TOAST_MEDIUM)
}

/** 非循环 DONE 路径的自检未通过告警（fail-open，不阻断） */
export function notifySelfcheckReject(reason: string | undefined): void {
  toast(`自检未通过：${reason || 'hook rejected'}`, 'warn', TOAST_LONG)
}
