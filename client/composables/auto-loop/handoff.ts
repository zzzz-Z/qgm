// [refactor-auto-loop] handoff
import { toast } from '../useToast.js'
import { useTraceLog } from '../useTraceLog.js'
import { getTransport } from '../useAiTransport.js'
import type { LoopInstance } from '../useAutoLoop.js'
import { activeLoop, enterWaiting, isLoopActive, persist, unbindKeyboard } from '../useAutoLoop.js'

const { addTrace } = useTraceLog()
const transport = getTransport()
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
export async function startHandoff(): Promise<void> {
  const inst = activeLoop.value
  if (!inst || !isLoopActive.value) { toast('没有进行中的循环', 'warn'); return }
  if (inst.state.value === 'handoff') { toast('已在轮转中', 'warn'); return }
  inst.state.value = 'handoff'
  persist(inst)
  addTrace({ kind: 'loop', summary: '🔄 开始轮转 · 请求 AI 总结当前会话', payload: { loopId: inst.id.value, loopRound: inst.round.value } })
  const okSent = transport.sendRotate('', { instruction: SUMMARY_INSTRUCTION })
  if (!okSent) { handoffFail(inst, '发送 rotate 失败（窗口已关？）'); return }
  handoffArm(inst, '总结请求超时（30s）')
}
export async function onSummary(text: string, sessionId: string, degraded: boolean): Promise<void> {
  const inst = activeLoop.value
  if (!inst || inst.state.value !== 'handoff') return
  handoffDisarm(inst)
  const t = String(text || '').trim()
  const finalSummary = t || localFallbackSummary(inst)
  const wasDegraded = degraded || !t
  addTrace({
    kind: 'loop',
    summary: wasDegraded ? '⚠ 摘要降级为本地拼' : `✓ 已收到 AI 总结（${t.length} 字）`,
    payload: { loopId: inst.id.value, loopRound: inst.round.value, summary: finalSummary.slice(0, 2000) },
  })
  const okSent = transport.sendNewSession('', { summary: finalSummary })
  if (!okSent) { handoffFail(inst, '发送 new-session 失败'); return }
  handoffArm(inst, '新会话创建超时（30s）')
}
export async function onNewSessionCreated(url: string, id: string): Promise<void> {
  const inst = activeLoop.value
  if (!inst || inst.state.value !== 'handoff') return
  handoffDisarm(inst)
  inst.latestTokens.value = 0
  addTrace({
    kind: 'loop',
    summary: `✓ 已切到新会话 · ${id || url}`,
    payload: { loopId: inst.id.value, loopRound: inst.round.value },
  })
  inst.stopRequest.value = 'none'
  inst.state.value = 'waiting'
  persist(inst)
  enterWaiting(inst)
  toast(`✓ 已切到新会话 · ${id || url}`, 'success', 5000)
}
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
function handoffArm(inst: LoopInstance, msg: string) {
  handoffDisarm(inst)
  inst.handoffTimer = setTimeout(() => { handoffFail(inst, msg) }, 30_000)
}
function handoffDisarm(inst: LoopInstance) {
  if (inst.handoffTimer) { clearTimeout(inst.handoffTimer); inst.handoffTimer = null }
}
function handoffFail(inst: LoopInstance, reason: string) {
  handoffDisarm(inst)
  inst.stopReason.value = reason
  inst.state.value = 'stopped'
  persist(inst)
  transport.sendStop('')
  unbindKeyboard()
  // loopRegistry 已删（PLAN #17 单例回退）
  // if (inst.id.value) loopRegistry.unregister(inst.id.value)
  addTrace({ kind: 'loop', summary: `✗ 轮转失败 · ${reason}`, payload: { loopId: inst.id.value, loopRound: inst.round.value } })
  toast(`✗ 轮转失败：${reason}`, 'error', 6000)
}
