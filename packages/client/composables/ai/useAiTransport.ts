import * as ds from './useDeepseekUrl'
import { loopPaused } from './useAiWaiting.js'

type AiTransportKind = 'tampermonkey' | 'headless'

/** AI（接口） */
export interface AiTransport {
  readonly kind: AiTransportKind
  sendFill: (sid: string, payload: { prompt: string, context?: string }) => boolean
  sendOpen?: (sid: string, payload: { url?: string }) => boolean
  sendStop: (sid: string) => boolean
  sendRotate: (sid: string, payload: { instruction: string }) => boolean
  sendNewSession: (sid: string, payload: { summary: string }) => boolean
  onReply: (cb: (r: unknown, sid: string) => void) => () => void
  onTokenEstimate: (cb: (n: number, sid: string) => void) => () => void
  onSummary: (cb: (text: string, sid: string, degraded: boolean) => void) => () => void
  onNewSessionCreated: (cb: (url: string, id: string) => void) => () => void
  dispose: () => void
  /** [hardpause] 静音消息接收（暂停时不再接收油猴/AI 回包） */
  mute?: () => void
  /** [mute-flag] 恢复消息接收 */
  unMute?: () => void
  // [P3-1c] waitAck
  waitAck?: (t: string, sid: string, timeoutMs?: number) => Promise<boolean>
}

/** 键 */
const TRANSPORT_KEY = '__ai_transport'

let alwaysSkillsText = ''
let alwaysSkillsLoaded = false
let singleton: AiTransport | null = null

// [skill-always] 常驻 skill 文本缓存
// tampermonkey 通道走油猴直投，不经服务端 loader，因此前端需预取后 prepend
void loadAlwaysSkillsOnce()

/**
 * 加载 Always Skills Once
 */
async function loadAlwaysSkillsOnce() {
  if (alwaysSkillsLoaded) return
  alwaysSkillsLoaded = true
  try {
    const r = await fetch('/__ai/skills/always')
    const d = await r.json()
    if (d && d.ok && typeof d.text === 'string') alwaysSkillsText = d.text
  } catch { /* ignore */ }
}

/**
 * 执行 call Ds
 * @param name - name
 * @param args - args
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
 * 创建 Tampermonkey Transport
 */
export function createTampermonkeyTransport(): AiTransport {
  const replyCbs = new Set<(r: unknown, sid: string) => void>()
  const tokenCbs = new Set<(n: number, sid: string) => void>()
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
    else if (t === 'ai-runner:token-estimate') { const n = Number((d as { tokens?: number }).tokens || 0); for (const cb of tokenCbs) cb(n, sid) }
    else if (t === 'ai-runner:summary') { for (const cb of summaryCbs) cb(String((d as { text?: string }).text || ''), sid, Boolean((d as { degraded?: boolean }).degraded)) }
    else if (t === 'ai-runner:new-session-created') { for (const cb of newSidCbs) cb(String((d as { url?: string }).url || ''), String((d as { id?: string }).id || '')) }
  }
  if (typeof window !== 'undefined') window.addEventListener('message', onMessage)

  return {
    kind: 'tampermonkey',
    sendFill(sid, payload) {
      if (loopPaused.value) return false
      void sid
      const raw = String(payload.prompt || '')
      const prompt = alwaysSkillsText
        ? `[系统规则]` + `\n${alwaysSkillsText}\n\n` + `[用户指令]` + `\n${raw}`
        : raw
      return callDs('sendFill', { ...payload, prompt })
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
    onTokenEstimate(cb) { tokenCbs.add(cb); return () => { tokenCbs.delete(cb) } },
    onSummary(cb) { summaryCbs.add(cb); return () => { summaryCbs.delete(cb) } },
    onNewSessionCreated(cb) { newSidCbs.add(cb); return () => { newSidCbs.delete(cb) } },
    dispose() {
      if (typeof window !== 'undefined') window.removeEventListener('message', onMessage)
      replyCbs.clear(); tokenCbs.clear(); summaryCbs.clear(); newSidCbs.clear()
    },
  }
}

/**
 * 创建 Headless Transport
 * @param wsUrl - ws Url
 */
export function createHeadlessTransport(wsUrl?: string): AiTransport {
  const replyCbs = new Set<(r: unknown, sid: string) => void>()
  const tokenCbs = new Set<(n: number, sid: string) => void>()
  const summaryCbs = new Set<(t: string, sid: string, d: boolean) => void>()
  const newSidCbs = new Set<(url: string, id: string) => void>()
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
    ws.addEventListener('open', () => {
      const pending = queue.splice(0)
      for (const m of pending) { try { ws!.send(m) } catch {} }
      // 连上后请求服务端重放最近业务消息（reply/summary/new-session-created）
      try { ws!.send(JSON.stringify({ t: 'headless:request-replay', sid: 'default' })) } catch {}
    })
    ws.addEventListener('message', (ev) => {
      let msg: Record<string, unknown> | null
      try { msg = JSON.parse(String(ev.data)) } catch { return }
      if (!msg || typeof msg.t !== 'string') return
      const sid = String(msg.sid || '')
      if (msg.t === 'headless:reply') { for (const cb of replyCbs) cb(msg.reply, sid) }
      else if (msg.t === 'headless:script') { for (const cb of replyCbs) cb({ kind: 'script', item: msg.item }, sid) }
      else if (msg.t === 'headless:token-estimate') { for (const cb of tokenCbs) cb(Number(msg.tokens || 0), sid) }
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
      }
    })
    return ws
  }
  /** 发送 */
  function send(t: string, payload: Record<string, unknown>): boolean {
    const w = ensure()
    const s = JSON.stringify(Object.assign({ t }, payload))
    if (w.readyState === 1) { try { w.send(s) } catch { return false } return true }
    queue.push(s)
    return true
  }
  return {
    kind: 'headless',
    sendOpen(sid, p) { return send('headless:open', { sid, url: p.url }) },
    sendFill(sid, p) { if (loopPaused.value) return false; return send('headless:fill', { sid, prompt: p.prompt, context: p.context }) },
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
    onReply(cb) { replyCbs.add(cb); return () => { replyCbs.delete(cb) } },
    onTokenEstimate(cb) { tokenCbs.add(cb); return () => { tokenCbs.delete(cb) } },
    onSummary(cb) { summaryCbs.add(cb); return () => { summaryCbs.delete(cb) } },
    onNewSessionCreated(cb) { newSidCbs.add(cb); return () => { newSidCbs.delete(cb) } },
    dispose() { try { if (ws) ws.close() } catch {} ws = null; replyCbs.clear(); tokenCbs.clear(); summaryCbs.clear(); newSidCbs.clear() },
    mute() { replyCbs.clear(); tokenCbs.clear(); summaryCbs.clear(); newSidCbs.clear() },
    unMute() { /* headless 无副作用恢复 */ },
  }
}

// __URL_TRANSPORT_AWARE__ transport 偏好支持 URL 参数（跨 origin 稳定）
/**
 * 获取 Transport Kind
 */
export function getTransportKind(): AiTransportKind {
  try {
    if (typeof location !== 'undefined') {
      const v = new URL(location.href).searchParams.get('transport')
      if (v === 'headless') return 'headless'
      if (v === 'tampermonkey') return 'tampermonkey'
    }
    return localStorage.getItem(TRANSPORT_KEY) === 'headless' ? 'headless' : 'tampermonkey'
  } catch { return 'tampermonkey' }
}
/**
 * 设置 Transport Kind
 * @param k - k
 */
export function setTransportKind(k: AiTransportKind): void {
  try { localStorage.setItem(TRANSPORT_KEY, k) } catch {}
  if (singleton) { singleton.dispose(); singleton = null }
}
/**
 * 获取 Transport
 */
export function getTransport(): AiTransport {
  if (singleton) return singleton
  singleton = getTransportKind() === 'headless' ? createHeadlessTransport() : createTampermonkeyTransport()
  return singleton
}

// 兼容 useDeepseekUrl 的动态调用约定：返回 { transport } 容器
/**
 * 组合式函数 Ai Transport
 */
export function useAiTransport(): { transport: AiTransport } {
  return { transport: getTransport() }
}
