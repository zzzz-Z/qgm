// [transport-import-fix-v1] sendX 已从 useAiSite 迁至 useAiWindowSend；
// [CONSTRAINT] useAiWindowSend 反向 import 本模块（ESM 循环安全：callDs 运行时访问 ds[name]，不在顶层解构）；
// [CHANGE-IMPACT] 修复前 callDs('sendStop') 静默返回 false，暂停信号无法送达油猴；
import * as ds from './useAiWindowSend'
import { loopPaused } from './useAiWaiting.js'
import { useStorage } from '@vueuse/core'

type AiTransportKind = 'tampermonkey' | 'headless'

/** AI（接口） */
export interface AiTransport {
  readonly kind: AiTransportKind
  // [image-channel-v3] images 与 FillPayload.images 同源（DataURL 数组）；油猴分支全量透传，headless 分支显式挑字段
  // [CONSTRAINT] 字段可缺省，旧实现不识该字段不报错
  // [CHANGE-IMPACT] 消费方 useAiWindowSend.sendFill / copyAndFill 传参处，及 headless send('headless:fill') 载荷
  sendFill: (sid: string, payload: { prompt: string, context?: string, images?: string[] }) => boolean
  sendOpen?: (sid: string, payload: { url?: string }) => boolean
  sendStop: (sid: string) => boolean
  sendRotate: (sid: string, payload: { instruction: string }) => boolean
  sendNewSession: (sid: string, payload: { summary: string }) => boolean
  /** [headless-login-gui-v1] 引导式登录：请服务端起有头窗口让用户手动登录 */
  sendLoginGui?: (sid: string, url?: string) => boolean
  onReply: (cb: (r: unknown, sid: string) => void) => () => void
  onSummary: (cb: (text: string, sid: string, degraded: boolean) => void) => () => void
  /** [headless-state-err-v1] 订阅服务端 headless:state，UI 侧据此显示 error（如未登录） */
  onState?: (cb: (state: string, detail: string, sid: string) => void) => () => void
  onNewSessionCreated: (cb: (url: string, id: string) => void) => () => void
  dispose: () => void
  /** [hardpause] 静音消息接收（暂停时不再接收油猴/AI 回包） */
  mute?: () => void
  /** [mute-flag] 恢复消息接收 */
  unMute?: () => void
  // [P3-1c] waitAck
  waitAck?: (t: string, sid: string, timeoutMs?: number) => Promise<boolean>
}

/** 存储键：transport 偏好（'headless' | 'tampermonkey'） */
const TRANSPORT_KEY = '__ai_transport'

/**
 * transport 偏好响应式 ref（useStorage 托管）
 * [WHY] 原 3 文件 7 处命令式读写分散，无跨标签页同步；改用单例 ref 统一消费
 * [CONSTRAINT] URL ?transport= 参数优先级仍由 getTransportKind 保持，此 ref 仅承载 localStorage 层
 * [CHANGE-IMPACT] App.vue 4 处 + useAiWindowSend.isHeadless 均改为消费此 ref；移除后需同步清理
 */
export const transportKind = useStorage<AiTransportKind>(TRANSPORT_KEY, 'tampermonkey')

/** transport 单例；由 getTransport() 惰性创建，setTransportKind 时置空以触发切换 */
let singleton: AiTransport | null = null

/**
 * 反射调用 useAiWindowSend 导出的发送函数（sendFill / sendStop / …）
 * [WHY] ESM 循环安全：useAiWindowSend 反向 import 本模块，callDs 仅在调用时读取 ds[name]，不在顶层解构
 * [CONSTRAINT] 未知 name 或非函数时返回 false；返回 Promise 则 fire-and-forget 并吞掉 rejection
 * [CHANGE-IMPACT] 被 sendFill/sendStop/sendRotate/sendNewSession 依赖，签名变化会破坏油猴通道
 */
function callDs(name: string, ...args: unknown[]): boolean {
  const bag = ds as unknown as Record<string, unknown>
  const fn = bag[name]
  if (typeof fn !== 'function') return false
  try {
    const r = (fn as (...a: unknown[]) => unknown)(...args)
    if (r && typeof (r as Promise<unknown>).then === 'function') void (r as Promise<unknown>).catch(() => {})
    return true
  } catch { return false }
}

/**
 * 创建油猴通道 transport（window.postMessage 驱动）
 * [CONSTRAINT] 返回单例对象，dispose() 后才释放 window message 监听与回调集合
 * [CHANGE-IMPACT] 使用方需在卸载时调用 dispose()，否则 window message 监听泄漏
 */
export function createTampermonkeyTransport(): AiTransport {
  const replyCbs = new Set<(r: unknown, sid: string) => void>()
  const summaryCbs = new Set<(t: string, sid: string, d: boolean) => void>()
  const newSidCbs = new Set<(url: string, id: string) => void>()

  let muted = false
  /** 响应消息 */
  function onMessage(e: MessageEvent) {
    if (muted) return
    const d = e && e.data
    if (!d || typeof d !== 'object') return
    const t = (d as { type?: string }).type
    const sid = String((d as { sid?: string }).sid || (d as { sessionId?: string }).sessionId || '')
    if (t === 'ai-runner:reply') { for (const cb of replyCbs) cb((d as { reply?: unknown }).reply, sid) }
    else if (t === 'ai-runner:script') { for (const cb of replyCbs) cb({ kind: 'script', item: (d as { item?: unknown }).item }, sid) }
    else if (t === 'ai-runner:summary') { for (const cb of summaryCbs) cb(String((d as { text?: string }).text || ''), sid, Boolean((d as { degraded?: boolean }).degraded)) }
    else if (t === 'ai-runner:new-session-created') { for (const cb of newSidCbs) cb(String((d as { url?: string }).url || ''), String((d as { id?: string }).id || '')) }
  }
  // [no-vueuse] 保留原生 addEventListener：transport 工厂可在 setup scope 外被创建（模块级单例），
  // vueuse useEventListener 依赖 effectScope 自动清理，此处改用 dispose() 显式成对移除
  if (typeof window !== 'undefined') window.addEventListener('message', onMessage)

  return {
    kind: 'tampermonkey',
    sendFill(sid, payload) {
      if (loopPaused.value) return false
      void sid
      return callDs('sendFill', payload)
    },
    sendStop(sid) { void sid; return callDs('sendStop') },
    sendRotate(sid, payload) { void sid; return callDs('sendRotate', payload) },
    sendNewSession(sid, payload) { void sid; return callDs('sendNewSession', payload) },
    // [P3-1c] 油猴链路无服务端 ACK，立即返回 true（保持行为不变）
    waitAck: () => Promise.resolve(true),
    // 暂停时屏蔽消息接收（不移除监听，可 unMute 恢复）
    mute() {
      muted = true
    },
    unMute() {
      muted = false
    },
    onReply(cb) { replyCbs.add(cb); return () => { replyCbs.delete(cb) } },
    onSummary(cb) { summaryCbs.add(cb); return () => { summaryCbs.delete(cb) } },
    onNewSessionCreated(cb) { newSidCbs.add(cb); return () => { newSidCbs.delete(cb) } },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('message', onMessage)
      replyCbs.clear(); summaryCbs.clear(); newSidCbs.clear()
    },
  }
}

/**
 * 创建 headless 通道 transport（WebSocket 驱动）
 * [CONSTRAINT] 未连接时消息进 queue，open 后自动 flush；同样需调用 dispose() 释放
 * @param wsUrl 显式指定 WS 地址；省略时按 location 推导（https→wss）
 */
export function createHeadlessTransport(wsUrl?: string): AiTransport {
  const replyCbs = new Set<(r: unknown, sid: string) => void>()
  const summaryCbs = new Set<(t: string, sid: string, d: boolean) => void>()
  const newSidCbs = new Set<(url: string, id: string) => void>()
  // [headless-state-err-v1] 服务端 state 订阅（error 用于 UI 反馈）
  const stateCbs = new Set<(state: string, detail: string, sid: string) => void>()
  let ws: WebSocket | null = null
  const queue: string[] = []
  const ackWaiters: Array<{ sid: string, resolve: (ok: boolean) => void, timer: ReturnType<typeof setTimeout> }> = []

  function resolveUrl(): string {
    if (wsUrl) return wsUrl
    if (typeof location === 'undefined') return 'ws://127.0.0.1:5175/__ai/ws'
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/__ai/ws`
  }
  /** 确保 */
  function ensure(): WebSocket {
    if (ws && ws.readyState <= 1) return ws
    ws = new WebSocket(resolveUrl())
    // [no-vueuse] WS 事件监听保留原生：生命周期随 transport 而非组件，且需在 dispose 时整体 close
    ws.addEventListener('open', () => {
      // [no-non-null-v1] 捕获局部变量：回调执行前可能被 dispose 置 null；显式判空避免静默抛错
      const sock = ws
      if (!sock) return
      const pending = queue.splice(0)
      for (const m of pending) { try { sock.send(m) } catch { /* swallow: 单个消息 send 失败不阻断其余 queue */ } }
      // 连上后请求服务端重放最近业务消息（reply/summary/new-session-created）
      try { sock.send(JSON.stringify({ t: 'headless:request-replay', sid: 'default' })) } catch { /* swallow: 重放请求失败无副作用，等待新事件即可 */ }
    })
    ws.addEventListener('message', (ev) => {
      let msg: Record<string, unknown> | null
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (!msg || typeof msg.t !== 'string') return
      const sid = String(msg.sid || '')
      if (msg.t === 'headless:reply') { for (const cb of replyCbs) cb(msg.reply, sid) }
      else if (msg.t === 'headless:script') { for (const cb of replyCbs) cb({ kind: 'script', item: msg.item }, sid) }
      else if (msg.t === 'headless:summary') { for (const cb of summaryCbs) cb(String(msg.text || ''), sid, Boolean(msg.degraded)) }
      else if (msg.t === 'headless:new-session-created') { for (const cb of newSidCbs) cb(String(msg.url || ''), String(msg.id || '')) }
      else if (msg.t === 'headless:state') {
        // [P3-1c] 收到服务端 state 即视为 sendFill 已 ACK
        const sid = String((msg as Record<string, unknown>).sid || '')
        for (let i = ackWaiters.length - 1; i >= 0; i--) {
          if (ackWaiters[i].sid === sid) {
            const w = ackWaiters[i]
            clearTimeout(w.timer)
            w.resolve(true)
            ackWaiters.splice(i, 1)
          }
        }
        // [headless-state-err-v1] 把 state 派发给 UI；error 让用户看到具体原因（如未登录）
        const _st = String((msg as Record<string, unknown>).state || '')
        const _dt = String((msg as Record<string, unknown>).detail || '')
        for (const cb of stateCbs) { try { cb(_st, _dt, sid) } catch { /* swallow: 单订阅者异常不阻断其他 */ } }
      }
    })
    return ws
  }
  /** 发送 */
  function send(type: string, payload: Record<string, unknown>): boolean {
    const w = ensure()
    // [ws-frame-key-v1] 协议键名是 t（见 protocol.ts TransportMessage / attach-ws handleMessage），
    // 误用 type 键会被服务端判 unknown type 静默丢弃，UI 侧表现为「点了没反应」
    const s = JSON.stringify(Object.assign({ t: type }, payload))
    if (w.readyState === 1) { try { w.send(s) } catch { return false } return true }
    queue.push(s)
    return true
  }
  return {
    kind: 'headless',
    sendOpen(sid, p) { return send('headless:open', { sid, url: p.url }) },
    // [image-channel-v3] 原实现显式只挑 prompt/context，images 被丢；改为条件展开
    // [CONSTRAINT] images 缺省时不写入字段，保持旧载荷形状兼容旧服务端
    // [CHANGE-IMPACT] 服务端 headless:fill handler 需识别并消费 images，否则静默忽略
    sendFill(sid, p) { if (loopPaused.value) return false; return send('headless:fill', { sid, prompt: p.prompt, context: p.context, ...(p.images && p.images.length ? { images: p.images } : {}) }) },
    // [P3-1c] waitAck：等 headless:state 回包（filling/generating/error 任一），超时返回 false
    waitAck(_t, sid, timeoutMs = 3000) {
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          const i = ackWaiters.findIndex(w => w.sid === sid)
          if (i >= 0) ackWaiters.splice(i, 1)
          resolve(false)
        }, timeoutMs)
        ackWaiters.push({ sid, resolve, timer })
      })
    },
    sendStop(sid) { return send('headless:stop', { sid }) },
    sendRotate(sid, p) { return send('headless:rotate', { sid, instruction: p.instruction }) },
    sendNewSession(sid, p) { return send('headless:new-session', { sid, summary: p.summary }) },
    sendLoginGui(sid, url) { return send('headless:login-gui', { sid, url }) },
    onReply(cb) { replyCbs.add(cb); return () => { replyCbs.delete(cb) } },
    onSummary(cb) { summaryCbs.add(cb); return () => { summaryCbs.delete(cb) } },
    onNewSessionCreated(cb) { newSidCbs.add(cb); return () => { newSidCbs.delete(cb) } },
    onState(cb) { stateCbs.add(cb); return () => { stateCbs.delete(cb) } },
    dispose() { try { if (ws) ws.close() } catch { /* swallow: WS 已断/未建立，close 幂等失败忽略 */ } ws = null; replyCbs.clear(); summaryCbs.clear(); newSidCbs.clear(); stateCbs.clear() },
    mute() { replyCbs.clear(); summaryCbs.clear(); newSidCbs.clear(); stateCbs.clear() },
    unMute() { /* headless 无副作用恢复 */ },
  }
}

// __URL_TRANSPORT_AWARE__ transport 偏好支持 URL 参数（跨 origin 稳定）
/**
 * 读取当前 transport 偏好
 * [WHY] URL ?transport= 优先于 localStorage：URL 参数可跨 origin 稳定传递偏好（油猴直开 AI 站点场景）
 * [CONSTRAINT] 判定值只接受 'headless' / 'tampermonkey'，其余一律回落 tampermonkey
 * [CHANGE-IMPACT] 修改判定顺序会让用户已保存的偏好失效
 */
export function getTransportKind(): AiTransportKind {
  try {
    if (typeof location !== 'undefined') {
      const v = new URL(location.href).searchParams.get('transport')
      if (v === 'headless') return 'headless'
      if (v === 'tampermonkey') return 'tampermonkey'
    }
    // [use-storage-v1] 由 useStorage ref 提供值；URL 优先语义保留在上方
    return transportKind.value
  } catch { return 'tampermonkey' }
}
/**
 * 写入 transport 偏好并销毁现有单例
 * [WHY] 单例销毁是必要的：transport 持有 window message 监听 / WS 连接，切换后必须释放
 * [CONSTRAINT] 不立即重建单例，下次 getTransport() 时按新偏好惰性创建
 */
export function setTransportKind(k: AiTransportKind): void {
  // [use-storage-v1] ref 赋值即持久化（useStorage 内部兜底配额/隐私模式异常）
  transportKind.value = k
  if (singleton) { singleton.dispose(); singleton = null }
}
/**
 * 获取 transport 单例（惰性创建）
 * [CONSTRAINT] 单例跨组件共享；setTransportKind 后为 null，下次调用按新偏好重建
 */
export function getTransport(): AiTransport {
  if (singleton) return singleton
  singleton = getTransportKind() === 'headless' ? createHeadlessTransport() : createTampermonkeyTransport()
  return singleton
}

// 兼容 useAiSite 的动态调用约定：返回 { transport } 容器
/**
 * 组合式入口：返回 { transport } 容器（兼容 useAiSite 的动态调用约定）
 * [CONSTRAINT] 返回的是模块级单例，多组件调用共享同一 transport
 */
export function useAiTransport(): { transport: AiTransport } {
  return { transport: getTransport() }
}
