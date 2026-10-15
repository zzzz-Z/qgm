import { useStorage } from '@vueuse/core'
// [transport-import-fix-v1] sendX 已从 useAiSite 迁至 useAiWindowSend；
// [CONSTRAINT] useAiWindowSend 反向 import 本模块（ESM 循环安全：callDs 运行时访问 ds[name]，不在顶层解构）；
// [CHANGE-IMPACT] 修复前 callDs('sendStop') 静默返回 false，暂停信号无法送达油猴；
import * as ds from './useAiWindowSend'

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
  // [replay-flag-v1] 第三参 replayed=true 表示断线重连的历史回放帧，消费方仅可做 UI 恢复、禁止重入 auto-loop
  onReply: (cb: (r: unknown, sid: string, replayed?: boolean) => void) => () => void
  onSummary: (cb: (text: string, sid: string, degraded: boolean) => void) => () => void
  /** [headless-state-err-v1] 订阅服务端 headless:state，UI 侧据此显示 error（如未登录） */
  onState?: (cb: (state: string, detail: string, sid: string) => void) => () => void
  /** [stop-diag-v1] 订阅 headless:stop-diag 诊断回传 */
  onStopDiag?: (cb: (count: number, brief: string, sid: string) => void) => () => void
  /** [url-updated-v1] 订阅 headless:url-updated URL 变化 */
  onUrlUpdated?: (cb: (url: string, sid: string) => void) => () => void
  /** [fs-watch-v1] 订阅 files:changed（服务端 fs.watch 广播，全局帧无 sid） */
  onFilesChanged?: (cb: (paths: string[]) => void) => () => void
  /** [fs-watch-v1] 订阅 git:changed（.git/index / HEAD 变动） */
  onGitChanged?: (cb: () => void) => () => void
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
  // [ds-bag-v1] ds 为油猴注入的全局对象，类型来自运行时；此处一次性收窄为可索引对象，供按名调用
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
  const replyCbs = new Set<(r: unknown, sid: string, replayed?: boolean) => void>()
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
    if (t === 'ai-runner:reply') {
      // [tm-reply-shape-v2] tampermonkey 实际把 kind/text 平铺在**顶层**（见 classifyAndPost 的 post({ type, kind, text, sessionId, site })），
      //   不包 reply 字段。原写法 cb(d.reply, sid) 会拿到 undefined —— 诊断日志实测 raw=undefined 印证。
      //   兼容两种格式：有 reply 字段用它，没有则用 d 自身作为 raw。
      const payload = (d as { reply?: unknown }).reply
      const raw = payload !== undefined ? payload : d
      for (const cb of replyCbs) cb(raw, sid)
    } else if (t === 'ai-runner:script') { for (const cb of replyCbs) cb({ kind: 'script', item: (d as { item?: unknown }).item }, sid) }
    else if (t === 'ai-runner:summary') { for (const cb of summaryCbs) cb(String((d as { text?: string }).text || ''), sid, Boolean((d as { degraded?: boolean }).degraded)) }
    else if (t === 'ai-runner:new-session-created') { for (const cb of newSidCbs) cb(String((d as { url?: string }).url || ''), String((d as { id?: string }).id || '')) }
  }
  // [no-vueuse] 保留原生 addEventListener：transport 工厂可在 setup scope 外被创建（模块级单例），
  // vueuse useEventListener 依赖 effectScope 自动清理，此处改用 dispose() 显式成对移除
  if (typeof window !== 'undefined') window.addEventListener('message', onMessage)

  return {
    kind: 'tampermonkey',
    sendFill(sid, payload) {
      // [manual-fill-bypass-paused-v1] 不在传输层拦截 paused：自动续推（PLAN/ASK/multi/startLoop）
      // 各调用点已自行检查 loopPaused；此处再拦会误杀「用户在输入框主动发送」——
      // 而 loopPaused 持久化在 sessionStorage，异常循环残留 true 后刷新不清，手动消息全部静默丢失
      return callDs('sendFillImpl', payload, sid)
    },
    sendStop(sid) { return callDs('sendStopImpl', sid) },
    sendRotate(sid, payload) { return callDs('sendRotateImpl', payload, sid) },
    sendNewSession(sid, payload) { return callDs('sendNewSessionImpl', payload, sid) },
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
  const replyCbs = new Set<(r: unknown, sid: string, replayed?: boolean) => void>()
  const summaryCbs = new Set<(t: string, sid: string, d: boolean) => void>()
  const newSidCbs = new Set<(url: string, id: string) => void>()
  // [headless-state-err-v1] 服务端 state 订阅（error 用于 UI 反馈）
  const stateCbs = new Set<(state: string, detail: string, sid: string) => void>()
  // [fs-watch-v1] 全局帧（无 sid），与 headless:xxx 帧共享同一条 WS
  const filesChangedCbs = new Set<(paths: string[]) => void>()
  const gitChangedCbs = new Set<() => void>()
  // [stop-diag-v1] / [url-updated-v1] 与油猴同名帧对齐：诊断摘要与 URL 变化派发给 UI
  const stopDiagCbs = new Set<(count: number, brief: string, sid: string) => void>()
  const urlUpdatedCbs = new Set<(url: string, sid: string) => void>()
  let ws: WebSocket | null = null
  let muted = false
  const queue: string[] = []
  const ackWaiters: Array<{ sid: string, resolve: (ok: boolean) => void, timer: ReturnType<typeof setTimeout> }> = []

  // [ws-reconnect-v1] dev 后端重启 / 网络抖动后旧 socket 半开：浏览器仍报 OPEN，send() 不抛错但帧永不到达，
  // 表层即「发消息没反应」。close/error 后指数退避自动重连，排队帧在 open 后 flush，业务无感知
  const RECONNECT_BASE_MS = 500
  const RECONNECT_MAX_MS = 10000
  let disposed = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = RECONNECT_BASE_MS
  function clearReconnect(): void {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null }
  }
  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (disposed) return
      try { ensure() } catch { scheduleReconnect() }
    }, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
  }

  function resolveUrl(): string {
    if (wsUrl) return wsUrl
    if (typeof location === 'undefined') return 'ws://127.0.0.1:5175/__ai/ws'
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}/__ai/ws`
  }
  /** 确保 */
  function ensure(): WebSocket {
    if (ws && ws.readyState <= 1) return ws
    const sock = new WebSocket(resolveUrl())
    ws = sock
    // [no-vueuse] WS 事件监听保留原生：生命周期随 transport 而非组件，且需在 dispose 时整体 close
    sock.addEventListener('open', () => {
      // [no-non-null-v1] 捕获局部变量：回调执行前可能被 dispose 置 null；显式判空避免静默抛错
      if (ws !== sock) return
      reconnectDelay = RECONNECT_BASE_MS
      const pending = queue.splice(0)
      for (const m of pending) { try { sock.send(m) } catch { /* swallow: 单个消息 send 失败不阻断其余 queue */ } }
      // 连上后请求服务端重放最近业务消息（reply/summary/new-session-created）
      try { sock.send(JSON.stringify({ t: 'headless:request-replay', sid: 'default' })) } catch { /* swallow: 重放请求失败无副作用，等待新事件即可 */ }
    })
    // [ws-reconnect-v1] error 后浏览器通常还会补发 close；两处共用 scheduleReconnect 的去重守卫
    sock.addEventListener('error', () => {
      // 半死连接：readyState 可能仍 CONNECTING，error 后直接摘除引用，避免 ensure() 复用死 socket
      if (ws === sock) ws = null
      scheduleReconnect()
    })
    sock.addEventListener('close', () => {
      if (ws === sock) ws = null
      scheduleReconnect()
    })
    sock.addEventListener('message', (ev) => {
      let msg: Record<string, unknown> | null
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (!msg || typeof msg.t !== 'string') return
      if (muted) return
      const sid = String(msg.sid || '')
      // [replay-flag-v1] 重连重放帧带 replay:true；同标记透传给回调，App.vue 据此拒绝重入 auto-loop
      const replayed = Boolean(msg.replay)
      // [fill-ack-v1] 与油猴 ai-runner:fill-ack 对齐：无头侧显式回执注入结果，唤醒 waitAck。
      // 原实现只能靠 headless:state 间接推断，fill 失败时与成功同形。
      if (msg.t === 'headless:fill-ack') {
        const ackSid = String((msg as Record<string, unknown>).sid || '')
        for (let i = ackWaiters.length - 1; i >= 0; i--) {
          if (ackWaiters[i].sid === ackSid) {
            const w = ackWaiters[i]
            clearTimeout(w.timer)
            w.resolve(Boolean((msg as Record<string, unknown>).ok))
            ackWaiters.splice(i, 1)
          }
        }
      }
      else if (msg.t === 'headless:stop-diag') {
        // [stop-diag-v1] 与油猴 stop-diag 对齐：stop 失败时把候选按钮摘要派发给 UI，供排查
        for (const cb of stopDiagCbs) { try { cb(Number((msg as Record<string, unknown>).count || 0), String((msg as Record<string, unknown>).brief || ''), sid) } catch { /* swallow */ } }
      }
      else if (msg.t === 'headless:url-updated') {
        // [url-updated-v1] 与油猴 ai-runner:url-updated 对齐：会话 URL 变化派发给 UI
        for (const cb of urlUpdatedCbs) { try { cb(String((msg as Record<string, unknown>).url || ''), sid) } catch { /* swallow */ } }
      }
      else if (msg.t === 'files:changed') {
        // [fs-watch-v1] 服务端 fs.watch 广播；无 sid，直接派发路径数组
        const paths = Array.isArray((msg as { paths?: unknown }).paths) ? (msg as { paths: unknown[] }).paths.map(String) : []
        for (const cb of filesChangedCbs) { try { cb(paths) } catch { /* swallow: 单订阅者异常不阻断其他 */ } }
      }
      else if (msg.t === 'git:changed') {
        // [fs-watch-v1] .git/index / HEAD 变动；无载荷
        for (const cb of gitChangedCbs) { try { cb() } catch { /* swallow: 单订阅者异常不阻断其他 */ } }
      }
      else if (msg.t === 'headless:reply') { for (const cb of replyCbs) cb(msg.reply, sid, replayed) }
      else if (msg.t === 'headless:script') { for (const cb of replyCbs) cb({ kind: 'script', item: msg.item }, sid, replayed) }
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
    // 返回局部 sock：ws 变量可能被异步 close 回调置空，同步返回新建实例语义更精确
    return sock
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
    // [manual-fill-bypass-paused-v1] 同 tampermonkey 通道：传输层不拦 paused（理由见上方同名注释）
    // [image-channel-v3] 原实现显式只挑 prompt/context，images 被丢；改为条件展开
    // [CONSTRAINT] images 缺省时不写入字段，保持旧载荷形状兼容旧服务端
    // [CHANGE-IMPACT] 服务端 headless:fill handler 需识别并消费 images，否则静默忽略
    sendFill(sid, p) { return send('headless:fill', { sid, prompt: p.prompt, context: p.context, ...(p.images && p.images.length ? { images: p.images } : {}) }) },
    // [P3-1c] waitAck：等 headless:state 回包（filling/generating/error 任一），超时返回 false
    waitAck(_t, sid, timeoutMs = 3000) {
      // [sid-normalize-v1] 服务端 attach-ws 用 `msg.sid || 'default'` 归一化，回包 sid 恒为 'default'；
      // 客户端若以原始 '' 注册 waiter，永远匹配不上 ACK → 3s 超时（隐藏 bug）
      const normalizedSid = sid || 'default'
      return new Promise<boolean>((resolve) => {
        let waiter: { sid: string, resolve: (ok: boolean) => void, timer: ReturnType<typeof setTimeout> }
        const timer = setTimeout(() => {
          const i = ackWaiters.indexOf(waiter)
          if (i >= 0) ackWaiters.splice(i, 1)
          resolve(false)
        }, timeoutMs)
        waiter = { sid: normalizedSid, resolve, timer }
        ackWaiters.push(waiter)
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
    onStopDiag(cb) { stopDiagCbs.add(cb); return () => { stopDiagCbs.delete(cb) } },
    onUrlUpdated(cb) { urlUpdatedCbs.add(cb); return () => { urlUpdatedCbs.delete(cb) } },
    onFilesChanged(cb) { filesChangedCbs.add(cb); return () => { filesChangedCbs.delete(cb) } },
    onGitChanged(cb) { gitChangedCbs.add(cb); return () => { gitChangedCbs.delete(cb) } },
    // [ws-reconnect-v1] disposed 阻断重连定时器；切换 transport 时旧连接彻底退役，不产生僵尸重连
    // [dispose-leak-v1] queue / ackWaiters 亦须清理：前者滞留字符串引用，后者悬挂 timer + Promise
    dispose() { disposed = true; muted = false; clearReconnect(); try { if (ws) ws.close() } catch { /* swallow: WS 已断/未建立，close 幂等失败忽略 */ } ws = null; queue.length = 0; for (const w of ackWaiters) { clearTimeout(w.timer); w.resolve(false) } ackWaiters.length = 0; replyCbs.clear(); summaryCbs.clear(); newSidCbs.clear(); stateCbs.clear(); filesChangedCbs.clear(); gitChangedCbs.clear() },
    // [mute-flag-v1] 用 flag 静音；原实现清空回调集合不可恢复，unMute 后所有订阅者永久失联
    mute() { muted = true },
    unMute() { muted = false },
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

// [hmr-dispose-v1] dev 热替换本模块前关掉旧单例：否则旧 WS 保持连接、旧回调闭包继续处理帧，
// 与新模块实例并存 → 同一回复被多代状态机消费（重复续跑/重复弹窗），且旧连接永不释放
// [CONSTRAINT] 本文件同时被根 tsconfig 类型检查（不含 vite/client 的 ImportMeta.hot 增强），
// 故局部收窄出 dispose 面，避免跨 tsconfig 依赖类型声明
const _hmr = (import.meta as unknown as { hot?: { dispose: (cb: () => void) => void } }).hot
if (_hmr) {
  _hmr.dispose(() => {
    try { singleton?.dispose() } catch { /* swallow: HMR 清理竞态 */ }
    singleton = null
  })
}
