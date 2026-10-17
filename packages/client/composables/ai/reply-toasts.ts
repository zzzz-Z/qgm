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

/** 等待当前轮结束超时：脚本已回填编辑器，需用户手动处理（工作台无「执行编辑器内容」按钮） */
export function notifyWaitTimeout(): void {
  toast('当前轮持续未结束，脚本已回填编辑器；请等本轮结束后重新发送', 'warn', TOAST_LONG)
}

/** 非循环 DONE 路径的自检未通过告警（fail-open，不阻断） */
export function notifySelfcheckReject(reason: string | undefined): void {
  toast(`自检未通过：${reason || 'hook rejected'}`, 'warn', TOAST_LONG)
}
/**
 * [resume-watchdog-v1] 续推后迟迟无真实回复：可能再次中断，或页面探针静默失效。
 * [WHY] 这条链路的失败默认是静默的（回复被抑制窗口吞 / 探针选择器改版），
 *   不给提示用户只能看到页面不动，无从判断该等还是该手动继续。
 */
export function notifyResumeTimeout(seconds: number): void {
  toast(`自动续推后 ${seconds} 秒未收到回复，可能已再次中断或页面探针失效，请手动继续`, 'warn', TOAST_LONG)
}

/** [stop-resume-v1] 自动续推达上限：明确告知用户，不再静默（停手让用户处理） */
export function notifyResumeExhausted(max: number): void {
  toast(`平台中断后已自动续推 ${max} 次仍未完成，请手动处理`, 'warn', TOAST_LONG)
}
