import { log } from '../../utils/log'
import { transportKind } from './useAiTransport'
import { getActiveWinSid, getWindowBySid, targetOriginFor } from './useAiWindowTable'

/** fill 消息载荷：向 AI 窗口投递的提问文本 */
export interface FillPayload {
  prompt: string
  /** 可选：附加上下文/契约摘要，由调用方组装 */
  context?: string
  /**
   * 可选：图片 DataURL 数组（data:image/*;base64,...）
   * [image-channel-v2] 图片走独立通道而非塞进 prompt，避免油猴侧需从文本 parse
   * [CONSTRAINT] 单张大小 ≈ MAX_ATTACH_BYTES×4/3；接收端需实现 images→粘贴逻辑，否则静默丢弃
   * [CHANGE-IMPACT] 消费方 sendFillTo / headless transport.sendFill；旧接收端不识该字段不报错
   */
  images?: string[]
}

/** rotate 消息载荷：切换会话/话题的指令 */
export interface RotatePayload { instruction: string }

/** new-session 消息载荷：开启新会话时携带的上下文总结 */
export interface NewSessionPayload { summary: string }

let _transportMod: Promise<typeof import('./useAiTransport.js')> | null = null

/** 动态加载 Transport（模块级单例） */
export function loadTransport() {
  if (!_transportMod) _transportMod = import('./useAiTransport.js')
  return _transportMod
}
// __URL_TRANSPORT_AWARE__ transport 偏好支持 URL 参数（跨 origin 稳定）
/** 判断是否 headless：URL 参数优先，其次 localStorage */
export function isHeadless(): boolean {
  try {
    if (typeof location !== 'undefined') {
      const v = new URL(location.href).searchParams.get('transport')
      if (v === 'headless') return true
      if (v === 'tampermonkey') return false
    }
    // [use-storage-v1] 消费 useAiTransport 导出的单例 ref；URL 优先语义保留在上方
    return transportKind.value === 'headless'
  } catch { return false }
}
/**
 * 通过 transport 层异步调用 headless 消息发送方法
 * [WHY] transport 动态 import 是异步的，此函数 fire-and-forget 不阻塞调用方
 * [CONSTRAINT] fn 在 transport 上不存在时静默忽略；新增协议字段时旧 transport 缺方法不应抛错
 */
function headlessSend(fn: string, ...args: unknown[]) {
  void loadTransport().then((mod) => {
    try {
      const t = mod.useAiTransport()
      const f = (t.transport as unknown as Record<string, (...a: unknown[]) => unknown>)[fn]
      if (typeof f === 'function') void f.apply(t.transport, args)
    } catch { /* swallow: transport 未就绪 / 方法缺失，headless 发送本就 fire-and-forget */ }
  })
}

/**
 * 向 AI 站点窗口发送 fill 消息。
 * - origin 精确到 protocol://host，不用 '*'
 * - 窗口未打开或已关闭 → 返回 false，调用方 toast 提示
 */
export function sendFillTo(sid: string, payload: FillPayload): boolean {
  const win = getWindowBySid(sid)
  if (!win) { log.warn('[sendFillTo] win=null sid=', sid, 'active=', getActiveWinSid()); return false }
  // [per-sid-origin-v1] 按 sid 查 windowTable 中的 url 计算 origin；多站点并存不再错发
  const origin = targetOriginFor(sid)
  if (!origin) { log.warn('[sendFillTo] origin="" sid=', sid); return false }
  try {
    win.postMessage({ type: 'ai-runner:fill', ...payload }, origin)
    return true
  } catch (e) {
    log.warn('[sendFillTo] postMessage threw', e)
    return false
  }
}
/**
 * 向当前激活槽位发 fill；headless 时走 transport.sendFill
 * [CONSTRAINT] headless 分支 fire-and-forget 恒返回 true；tampermonkey 分支返回实际发送结果
 */
export function sendFill(payload: FillPayload): boolean {
  if (isHeadless()) { headlessSend('sendFill', getActiveWinSid(), payload); return true }
  return sendFillTo(getActiveWinSid(), payload)
}

/** 通知油猴停止（清 lastScript / Observer / 监听） */
export function sendStopTo(sid: string): boolean {
  const win = getWindowBySid(sid)
  if (!win) return false
  const origin = targetOriginFor(sid)
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:stop' }, origin)
    return true
  } catch {
    return false
  }
}
/** 向当前激活槽位发 stop */
export function sendStop(): boolean {
  if (isHeadless()) { headlessSend('sendStop', getActiveWinSid()); return true }
  return sendStopTo(getActiveWinSid())
}

/**
 * 向指定槽位发 rotate 指令（切换会话/话题）
 * [CONSTRAINT] origin 无法解析时返回 false，不用 '*'（违反 v6 §3.4 安全约束）
 */
export function sendRotateTo(sid: string, payload: RotatePayload): boolean {
  const win = getWindowBySid(sid)
  if (!win) return false
  const origin = targetOriginFor(sid)
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:rotate', ...payload }, origin)
    return true
  } catch { return false }
}
/** 向当前激活槽位发 rotate */
export function sendRotate(payload: RotatePayload): boolean {
  if (isHeadless()) { headlessSend('sendRotate', getActiveWinSid(), payload); return true }
  return sendRotateTo(getActiveWinSid(), payload)
}

/**
 * 通知指定槽位开启新会话
 * [CONSTRAINT] summary 由 session-prompt.buildNewSessionPrompt 拼好（SYSTEM.md + AGENTS.md + 总结），油猴侧不应再拼接
 */
export function sendNewSessionTo(sid: string, payload: NewSessionPayload): boolean {
  const win = getWindowBySid(sid)
  if (!win) return false
  const origin = targetOriginFor(sid)
  if (!origin) return false
  try {
    win.postMessage({ type: 'ai-runner:new-session', ...payload }, origin)
    return true
  } catch { return false }
}
/** 向当前激活槽位发 new-session */
export function sendNewSession(payload: NewSessionPayload): boolean {
  if (isHeadless()) { headlessSend('sendNewSession', getActiveWinSid(), payload); return true }
  return sendNewSessionTo(getActiveWinSid(), payload)
}
