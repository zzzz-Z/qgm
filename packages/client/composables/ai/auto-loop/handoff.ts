// handoff
import { toast } from '../../ui/useToast.js'
import { buildNewSessionPrompt } from '../session-prompt.js'
import { loopPaused } from '../useAiWaiting.js'
import { getTransport } from '../useAiTransport.js'
import type { LoopInstance } from '../useAutoLoop.js'
import { activeLoop, enterWaiting, isLoopActive, persist, unbindKeyboard } from '../useAutoLoop.js'

/** 传输层实例（sendFill / sendStop 等） */
const transport = getTransport()
/** [handoff] 交接总结模板：发给 AI 生成结构化摘要，供新会话续接；严格结构由下游 parseHandoffSummary 解析 */
export const SUMMARY_INSTRUCTION = [
  '请将本次会话总结为以下格式，供新会话继续工作：',
  '',
  '# 任务',
  '<当前任务目标>',
  '',
  '# 已完成',
  '<已完成的工作要点>',
  '',
  '# 当前状态',
  '<最后的工作状态 / 最近的执行结果>',
  '',
  '# 下一步',
  '<待完成的工作>',
  '',
  '# 关键文件',
  '<涉及的路径列表>',
  '',
  '只输出上述结构，不加其他文字、不加代码块。',
].join('\n')
/**
 * 启动会话轮转：向 AI 发送总结指令，进入 handoff 状态等待回复
 * [WHY] 长会话易触及模型上下文上限，主动总结→新会话比等模型报错更平滑
 * [CONSTRAINT] 无活动循环或已处于 handoff 时直接返回并 toast；sendRotate 失败立即 handoffFail
 * [CHANGE-IMPACT] 会置 inst.state='handoff' 并 arm 30s 超时定时器（handoffArm）
 */
export async function startHandoff(): Promise<void> {
  const inst = activeLoop.value
  if (!inst || !isLoopActive.value) { toast('没有进行中的循环', 'warn'); return }
  if (inst.state.value === 'handoff') { toast('已在轮转中', 'warn'); return }
  inst.state.value = 'handoff'
  persist(inst)
  const okSent = transport.sendRotate('', { instruction: SUMMARY_INSTRUCTION })
  if (!okSent) { handoffFail(inst, '发送 rotate 失败（窗口已关？）'); return }
  handoffArm(inst, '总结请求超时（30s）')
}
/**
 * AI 返回总结后触发：把摘要发给新会话创建流程
 * [CONSTRAINT] 只处理 state='handoff' 的循环；text 为空时用 localFallbackSummary 兜底
 * [CHANGE-IMPACT] 会 disarm 当前超时定时器，并 arm 新的（等待 new-session-created）
 * @param degraded 服务端标记的降级摘要；当前仅形参保留（trace-removed 后无消费方）
 */
export async function onSummary(text: string, sessionId: string, degraded: boolean): Promise<void> {
  if (loopPaused.value) return // [loop-paused:summary] 暂停中忽略 AI 回填
  const inst = activeLoop.value
  if (!inst || inst.state.value !== 'handoff') return
  handoffDisarm(inst)
  const t = String(text || '').trim()
  const finalSummary = t || localFallbackSummary(inst)
  void degraded // [trace-removed] 形参保留以兼容调用方签名
  const full = await buildNewSessionPrompt(finalSummary)
  const okSent = transport.sendNewSession('', { summary: full })
  if (!okSent) { handoffFail(inst, '发送 new-session 失败'); return }
  handoffArm(inst, '新会话创建超时（30s）')
}
/**
 * 新会话创建成功：重置 stopRequest、切 waiting、arm 键盘监听
 * [CONSTRAINT] 只处理 state='handoff' 的循环；pause 中直接忽略
 * [CHANGE-IMPACT] 会 disarm 超时定时器；丢失此回调会让 30s 定时器误触发 handoffFail
 */
export async function onNewSessionCreated(url: string, id: string): Promise<void> {
  if (loopPaused.value) return // [loop-paused:newsession] 暂停中忽略新会话回调
  const inst = activeLoop.value
  if (!inst || inst.state.value !== 'handoff') return
  handoffDisarm(inst)
  inst.stopRequest.value = 'none'
  inst.state.value = 'waiting'
  persist(inst)
  enterWaiting(inst)
  toast(`✓ 已切到新会话 · ${id || url}`, 'success', 5000)
}
/**
 * 本地生成降级摘要（AI 未返回或摘要为空时）
 * [WHY] 交接流程不能因 AI 无响应而中断；本地摘要保证新会话至少有 goal 与轮次信息
 * [CONSTRAINT] 与 SUMMARY_INSTRUCTION 结构需部分一致，便于人工阅读
 */
function localFallbackSummary(inst: LoopInstance): string {
  const lines = [
    '# 任务',
    inst.goal.value || '（无）',
    '',
    '# 当前状态',
    `已完成 ${inst.round.value} 轮；最后执行：${inst.lastExec.value ? JSON.stringify(inst.lastExec.value) : '无'}`,
    '',
    '# 下一步',
    '继续推进目标',
  ]
  return lines.join('\n')
}
/**
 * 启动交接超时定时器（默认 30s）
 * [CONSTRAINT] 会先 disarm 现有定时器，保证同一时刻最多一个挂起
 * [CHANGE-IMPACT] 超时未收到对端回调 → handoffFail；对端回调必须先 handoffDisarm 再 arm
 * @param msg 超时时展示给用户的错误原因
 */
function handoffArm(inst: LoopInstance, msg: string) {
  handoffDisarm(inst)
  inst.handoffTimer = setTimeout(() => { handoffFail(inst, msg) }, 30_000)
}
/**
 * 清除交接超时定时器；幂等
 * [CONSTRAINT] inst.handoffTimer 置 null 以标记无挂起定时器
 */
function handoffDisarm(inst: LoopInstance) {
  if (inst.handoffTimer) { clearTimeout(inst.handoffTimer); inst.handoffTimer = null }
}
/**
 * 交接失败统一出口：置 stopped 并通知用户
 * [WHY] 三个失败点（send rotate / send new-session / 30s 超时）共用收尾，避免重复代码
 * [CONSTRAINT] loopPaused 时仅停状态不 sendStop（暂停中的循环不存在活动 socket）
 * [CHANGE-IMPACT] 会 unbind 键盘监听并 disarm 定时器；重复调用无副作用
 */
function handoffFail(inst: LoopInstance, reason: string) {
  handoffDisarm(inst)
  // [loop-paused:handoff] 暂停中直接置 stopped
  if (loopPaused.value) {
    inst.state.value = 'stopped'
    persist(inst)
    return
  }
  inst.stopReason.value = reason
  inst.state.value = 'stopped'
  persist(inst)
  transport.sendStop('')
  unbindKeyboard()
  toast(`✗ 轮转失败：${reason}`, 'error', 6000)
}
