// [transport-static-import-v1] useAiTransport 已被 App.vue/WorklogPane 等多处静态引入，
// 动态 import 只会触发 INEFFECTIVE_DYNAMIC_IMPORT；改为命名空间静态导入，
// loadTransport() 以 Promise.resolve 保留异步签名，调用方零改动
import * as transportMod from './useAiTransport.js'
import { getActiveWinSid, getWindowBySid, targetOriginFor } from './useAiWindowTable'
import { log } from '../../utils/log' // [restore-import-v1] 早前清理误删
import { traceSend } from './send-trace' // [send-trace-v1] 出站留痕（P1-3）

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
  /**
   * [send-trace-v1] 出站留痕的调用点归因（loop-round / copyOutput / …）
   * [CONSTRAINT] **不进入线上协议**：postMessage 前会被剥掉 —— 油猴不认这个字段，
   *   多带只会污染协议载荷；它纯粹是本地的观测标记。
   */
  source?: string
}

/** rotate 消息载荷：切换会话/话题的指令 */
export interface RotatePayload { instruction: string }

/**
 * new-session 消息载荷：开启新会话时携带的**首问正文**
 * [no-handoff-summary-v1] 字段名沿用 `summary`（协议兼容），但内容不再是「上一轮总结」：
 *   由 session-prompt.buildNewSessionPrompt 拼成「规则/技能/lessons + 目标」。
 *   当前油猴端已不消费该字段（只切会话），headless 端同理。
 */
export interface NewSessionPayload { summary: string }

/** Transport 模块（已静态化；保留 Promise 形态兼容既有 await loadTransport() 调用点） */
const _transportMod: Promise<typeof import('./useAiTransport.js')> = Promise.resolve().then(() => transportMod)

/** 加载 Transport（模块级单例；静态导入后此函数等价于常量 Promise） */
export function loadTransport() {
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
    return transportMod.transportKind.value === 'headless'
  } catch { return false }
}
/**
 * 通过 transport 层异步调用 headless 消息发送方法
 * [WHY] transport 动态 import 是异步的，此函数 fire-and-forget 不阻塞调用方
 * [CONSTRAINT] fn 在 transport 上不存在时静默忽略；新增协议字段时旧 transport 缺方法不应抛错
 */
function headlessSend(methodName: string, ...args: unknown[]) {
  void loadTransport().then((mod) => {
    try {
      const transport = mod.useAiTransport()
      // [dynamic-method-v1] 按名动态取 transport 方法；transport 接口未暴露索引签名，此处收窄一次
      const method = (transport.transport as unknown as Record<string, (...a: unknown[]) => unknown>)[methodName]
      if (typeof method === 'function') void method.apply(transport.transport, args)
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
    // [send-trace-v1] source 只服务留痕：剥掉后再上线，避免污染协议载荷
    const { source: traceSource, ...wire } = payload
    win.postMessage({ type: 'ai-runner:fill', ...wire }, origin)
    // [send-trace-v1] 出站留痕（P1-3）：逐条记 ts/sid/source/首部，供「发送间隔分布」与「同轮双发」定案
    traceSend({ sid, via: 'tm', source: traceSource || 'direct', prompt: payload.prompt, ok: true })
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
  if (isHeadless()) {
    headlessSend('sendFill', getActiveWinSid(), payload)
    traceSend({ sid: getActiveWinSid(), via: 'headless', source: payload.source || 'loop-round', prompt: payload.prompt, ok: true })
    return true
  }
  // [send-trace-v1] 生产路径里 sendFillTo 的直接调用方只有 ds 桥（循环引擎），故此处显式标 loop-round
  return sendFillTo(getActiveWinSid(), { source: 'loop-round', ...payload })
}

/**
 * 异步 fill：发帧后等油猴回 fill-ack；明确拒绝 = failed，超时/抛错 = unacked（结果未知）
 * [WHY] 同步 sendFillTo 的 postMessage 恒返回 true，对端是否存在/是否处理完全不可知 → UI 假「已发送」
 * [unacked-degrade-v1] 原实现在超时时硬判 failed → 旧版油猴（不回 fill-ack，仓库脚本须手动更新）
 *   每次新窗口注入系统提示词必弹「首问未送达」报错，但 fill 实际已被处理 → 误报。
 *   三态化：ack ok=true → sent；ack ok=false → failed（油猴明确说没送达）；
 *   超时/postMessage 抛错 → unacked（发帧结果未知，由调用方降级为按已发送处理并提示更新油猴）
 * [CONSTRAINT] ackId 由本函数生成并随帧下发；只匹配自己的 ackId，避免并发 fill 串话
 * [CHANGE-IMPACT] 返回类型从二元改三态：调用方（useAiWindow.fillWithDegrade 与测试）需同步适配；
 *   循环轮次内路径仍用 sendFillTo（行为不变）
 */
export function sendFillToAsync(sid: string, payload: FillPayload, timeoutMs = 5000): Promise<'sent' | 'failed' | 'unacked'> {
  const win = getWindowBySid(sid)
  if (!win) { log.warn('[sendFillToAsync] win=null sid=', sid); return Promise.resolve('failed') }
  const origin = targetOriginFor(sid)
  if (!origin) { log.warn('[sendFillToAsync] origin="" sid=', sid); return Promise.resolve('failed') }
  const ackId = `fa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return new Promise<'sent' | 'failed' | 'unacked'>((resolve) => {
    let done = false
    function finish(r: 'sent' | 'failed' | 'unacked'): void {
      if (done) return
      done = true
      window.removeEventListener('message', onMsg)
      resolve(r)
    }
    function onMsg(e: MessageEvent): void {
      const d = e && e.data
      if (!d || typeof d !== 'object') return
      const m = d as { type?: string, ackId?: string, ok?: boolean }
      if (m.type !== 'ai-runner:fill-ack') return
      if (String(m.ackId || '') !== ackId) return
      finish(m.ok ? 'sent' : 'failed')
    }
    // [send-trace-v1] source 只服务留痕：剥掉后再上线，避免污染协议载荷
    const { source: traceSource, ...wire } = payload
    let posted = false
    try {
      window.addEventListener('message', onMsg)
      win.postMessage({ type: 'ai-runner:fill', ...wire, ackId }, origin)
      posted = true
    } catch (e) {
      log.warn('[sendFillToAsync] postMessage threw', e)
    }
    // [send-trace-v1] 出站留痕（P1-3）：抛错同样是一次真实出站尝试，用 ok 区分「送达」与「噪声」。
    //   本函数的唯一生产调用方是 copyAndFill（ScriptPanel/exec-flow 的结果回传），故默认归因 copyOutput。
    traceSend({ sid, via: 'tm', source: traceSource || 'copyOutput', prompt: payload.prompt, ok: posted })
    if (!posted) { finish('unacked'); return }
    setTimeout(finish, timeoutMs, 'unacked')
  })
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
 * [CONSTRAINT] origin 无法解析时返回 false，不用 '*'（违反安全约束）
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
 * [CONSTRAINT] summary 由 session-prompt.buildNewSessionPrompt 拼好（SYSTEM.md + AGENTS.md + 技能 + lessons + 目标），
 *              油猴侧不应再拼接
 * [no-handoff-summary-v1] 载荷里已不含「上一轮总结」；油猴端当前不消费该字段（只切会话）
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
