// handoff
import { TOAST_LONG, TOAST_VERY_LONG } from '../../../utils/toast-durations'
import { toast } from '../../ui/useToast.js'
import { buildNewSessionPrompt } from '../session-prompt.js'
import { loopPaused } from '../useAiWaiting.js'
import { getTransport } from '../useAiTransport.js'
import type { LoopInstance } from '../useAutoLoop.js'
import { activeLoop, enterWaiting, isLoopActive, persist, unbindKeyboard } from '../useAutoLoop.js'
import { setLoopState } from './transitions.js'

/** 传输层实例（sendFill / sendStop 等） */
// [transport-dynamic-v1] Proxy 转发到 getTransport() 实时单例：setTransportKind 切换后旧引用不再失效
const transport = new Proxy({} as ReturnType<typeof getTransport>, {
  get(_target, prop) { return Reflect.get(getTransport() as object, prop) },
})
/**
 * [handoff] 交接总结模板：让 AI 在切会话前把本次工作收个尾（写给人和日志看）
 * [no-handoff-summary-v1] 该总结**不再被搬进新会话**（旧版行为已删，见 onSummary）：
 *   它由页面 DOM 反推获得，走到整页兜底时会夹带页面垃圾且无换行 ⇒ 新会话首问变一坨乱码。
 *   保留下发它的原因只剩两个：① AI 的回执是 handoff → 新会话状态机的推进信号；
 *   ② 收尾总结留在旧会话里便于人工回看。新会话首问改用 goal（见 session-prompt.ts）。
 */
// [reply-mark-v1] 首行为独占标记行 `HANDOFF`：与 SCRIPT / ASK / DONE 同构（第二行起才是载荷）。
//   旧模板以 `# 任务` 作首行，与 Markdown 一级标题同形（DOM→Markdown 反推把任何 <h1> 还原成 `# xxx`），
//   无法与摘要正文里的普通标题区分；`# 任务` 仍作为过渡别名被识别（见 utils/reply-mark.ts）
export const SUMMARY_INSTRUCTION = [
  '请将本次会话总结为以下格式，用于留档（新会话直接沿用目标，不需要你转述给新会话）：',
  '**首行必须恰好是 `HANDOFF`**（独占一行，前后只允许空白），第二行起才是摘要正文。',
  '',
  'HANDOFF',
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
  // [transitions-v1] HANDOFF 事件：waiting|feedback → handoff
  setLoopState(inst, 'HANDOFF')
  persist(inst)
  const okSent = transport.sendRotate('', { instruction: SUMMARY_INSTRUCTION })
  if (!okSent) { handoffFail(inst, '发送 rotate 失败（窗口已关？）'); return }
  handoffArm(inst, '总结请求超时（30s）')
}
/**
 * AI 返回总结后触发：创建新会话并交回目标
 * [CONSTRAINT] 只处理 state='handoff' 的循环；文本为空也照常推进（正文不再被消费）
 * [CHANGE-IMPACT] 会 disarm 当前超时定时器，并 arm 新的（等待 new-session-created）
 * [no-handoff-summary-v1] 不再把接收到的文本（AI 总结）搬进新会话：
 *   [WHY] 该文本由页面 DOM 反推，可能走到整页兜底（replyRoot=document）而把侧栏会话标题、
 *     问候语、输入区按钮文案一起抓来，且 textContent 路径无换行 ⇒ 整段黏成一行，
 *     最终表现为「新会话首问出现一坨页面垃圾」（实测 2026-10-07）。
 *   现在新会话首问只带规则/技能/lessons + 原始 goal（见 session-prompt.ts）。
 * @param text AI 返回的总结文本（不再消费；形参保留以兼容调用方签名）
 * @param sessionId 会话 id（不再消费；形参保留以兼容调用方签名）
 * @param degraded 服务端标记的降级摘要（不再消费；形参保留以兼容调用方签名）
 */
export async function onSummary(text: string, sessionId: string, degraded: boolean): Promise<void> {
  if (loopPaused.value) return // [loop-paused:summary] 暂停中忽略 AI 回填
  const inst = activeLoop.value
  if (!inst || inst.state.value !== 'handoff') return
  handoffDisarm(inst)
  // [no-handoff-summary-v1] 三个形参一律不消费：显式 void 掉，避免 lint 报未使用
  void text // 交接正文不再搬运（原因见 JSDoc）
  void sessionId // [trace-removed] 形参保留以兼容调用方签名
  void degraded // [trace-removed] 形参保留以兼容调用方签名
  // [query-source-v1] 检索用 goal：交接正文已不再进入首问，检索也只能以 goal 为据
  const goal = String(inst.goal.value || '').trim()
  const full = await buildNewSessionPrompt(goal, goal)
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
  // [transitions-v1] HANDOFF_OK 事件：handoff → waiting
  setLoopState(inst, 'HANDOFF_OK')
  persist(inst)
  enterWaiting(inst)
  toast(`✓ 已切到新会话 · ${id || url}`, 'success', TOAST_VERY_LONG)
}
// [REMOVED no-handoff-summary-v1] 原 localFallbackSummary()（AI 未返回总结时的本地降级摘要）
//   已删除：交接正文不再进入新会话首问（见 onSummary），该函数失去唯一消费方。勿复活。
/**
 * 启动交接超时定时器（默认 30s）
 * [CONSTRAINT] 会先 disarm 现有定时器，保证同一时刻最多一个挂起
 * [CHANGE-IMPACT] 超时未收到对端回调 → handoffFail；对端回调必须先 handoffDisarm 再 arm
 * @param inst 循环实例
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
export function handoffDisarm(inst: LoopInstance) {
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
    // [transitions-v1] HANDOFF_FAIL 事件（暂停分支）：handoff → stopped
    setLoopState(inst, 'HANDOFF_FAIL')
    persist(inst)
    return
  }
  inst.stopReason.value = reason
  // [transitions-v1] HANDOFF_FAIL 事件：handoff → stopped
  setLoopState(inst, 'HANDOFF_FAIL')
  persist(inst)
  transport.sendStop('')
  unbindKeyboard()
  toast(`✗ 轮转失败：${reason}`, 'error', TOAST_LONG)
}
