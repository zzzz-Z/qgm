// [loop-feedback-authority-v1] R1：循环引擎的结果回传 prompt
// [WHY] 循环模式下结果回传权归循环引擎，不再依赖 ScriptPanel watch 的 shouldAutoAsk——
//   后者在多脚本批量/暂停场景下漏发或双发，是「批量停摆」的根因
// [CONSTRAINT] 纯函数；不含 transport 依赖，便于单测与复用
import type { RoundOutcome } from './types.js'

/**
 * 组装「本轮执行结果」prompt，供循环引擎 sendFill 回传给 AI
 * [CONSTRAINT] 必含 desc / 状态 / exit / 变更数；stderr 截尾 500 字符
 * @param outcome 本轮执行结果（由 executeItemInner 构造）
 */
export function buildLoopResultPrompt(outcome: RoundOutcome): string {
  const status = outcome.ok ? '成功' : '失败'
  const desc = outcome.desc || '（无描述）'
  const files = outcome.changedFiles.length
    ? `\n变更文件：\n${outcome.changedFiles.map(f => `- ${f}`).join('\n')}`
    : '\n（无文件变更）'
  const tail = outcome.stderr ? `\n错误摘要：\n${outcome.stderr.slice(-500)}` : ''
  return `【本轮执行结果】${desc}\n状态：${status} · exit=${outcome.exit} · 变更 ${outcome.changeCount} 个文件${files}${tail}\n请阅读终端输出并给出下一步。`
}
