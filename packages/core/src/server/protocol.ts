// 共享 wire 类型：Node 侧（index.ts / ws-server.ts）与前端（useAiTransport.ts）共用。
// 只放纯类型，不引入 Vue / DOM 依赖。
// 见 headless-browser-and-core-extract.md §协议。

/** 收件箱条目的传输对象（来自 AI 的脚本） */
export interface InboxItemDto {
  id: string
  code: string
  lang: 'js' | 'cjs' | 'bash'
  site: string
  hash: string
  desc: string
  why: string
  ts: number
}

/** AI 回复类型枚举：脚本 / 纯文本 / DONE / 决策请求 */
export type AiReplyKind = 'script' | 'done' | 'plain' | 'multi' | 'error' | 'stopped' | 'limit' // [limit-detect-v1]

/** AI 回复的传输对象 */
export interface AiReplyDto {
  kind: AiReplyKind
  item?: InboxItemDto
  count?: number
  text?: string
}

/** 决策点选项的传输对象 */
export interface DecisionOptionDto {
  id: string
  label: string
}

/** 决策载荷的传输对象 */
export interface DecisionPayloadDto {
  question: string
  options: DecisionOptionDto[]
  default?: string
}

/** 请求外部文件的传输对象 */
export interface NeedFilesPayloadDto {
  paths: string[]
}

/** 传输层状态枚举：连接 / 断开 / 重连中 */
export type TransportState = 'idle' | 'filling' | 'generating' | 'done' | 'error' | 'rate-limited'

/** 无头浏览器状态传输对象 */
export interface HeadlessStateDto {
  sid: string
  state: TransportState
  detail?: string
}

/** 传输层消息联合类型 */
export interface TransportMessage {
  type: string
  [k: string]: unknown
}
// WS 消息联合类型（ws-server ↔ useAiTransport 共享）

/** 客户端 → 服务端消息联合类型 */
export type ClientMessage
  // [headless-session-switch-v1] nav=true 才按 url 导航（切工作区 / 开新会话）。
  //   [CONSTRAINT] 缺省（含旧版客户端，它一律带 url）必须是「不导航」——
  //   否则旧客户端的 fill 前 sendOpen 会把页面拽回它 localStorage 里的旧会话。
  = | { t: 'headless:open', sid: string, url?: string, nav?: boolean }
    | { t: 'headless:close', sid: string }
    | { t: 'headless:list' }
    // [fill-ack-id-v1] ackId 由客户端生成并透传，服务端原样回写；并发 fill 靠它区分归属
    | { t: 'headless:fill', sid: string, prompt: string, context?: string, images?: string[], ackId?: string }
    | { t: 'headless:stop', sid: string }
    | { t: 'headless:rotate', sid: string, instruction: string }
    | { t: 'headless:new-session', sid: string, summary: string }
    | { t: 'headless:login-gui', sid: string, url?: string }

/** 服务端 → 客户端消息联合类型 */
// [replay-flag-v1] 可缓存消息（reply/script/summary/new-session-created）在断线重连重放时带 replay:true；
// 客户端据此区分「实时回复」与「历史回放」：回放仅供 UI 恢复，禁止重入 auto-loop
export type ServerMessage
  = | { t: 'hello', version: number }
    | { t: 'headless:reply', sid: string, reply: AiReplyDto, replay?: boolean }
    | { t: 'headless:script', sid: string, item: InboxItemDto, replay?: boolean }
    | { t: 'headless:state', sid: string, state: TransportState, detail?: string }
    | { t: 'headless:new-session-created', sid: string, url: string, id: string, replay?: boolean }
    | { t: 'headless:summary', sid: string, text: string, degraded: boolean, replay?: boolean }
    | { t: 'headless:list', sessions: unknown[] }
    | { t: 'headless:error', error: string }
    | { t: 'headless:stop-diag', sid: string, count: number, brief: string }
    // [fill-ack-v1] 与油猴 ai-runner:fill-ack 对齐：工作台据此判定「已注入」而非靠 state 猜
    // [fill-ack-id-v1] ackId 回显请求侧的值（旧客户端不发则省略），客户端据此精确匹配自己的 waiter
    | { t: 'headless:fill-ack', sid: string, ok: boolean, reason: string, ackId?: string }
    // [url-updated-v1] 与油猴 ai-runner:url-updated 对齐：发送后轮询 URL 变化（最多 8s）
    | { t: 'headless:url-updated', sid: string, url: string }
    // [fs-watch-v1] 文件树 / git 状态变化广播：由 server/fs-watch.ts 的 recursive watcher 触发；
    // 不带 sid（全局事件，不进 replay 缓冲）——客户端按当前展开目录做增量刷新。
    | { t: 'files:changed', paths: string[] }
    | { t: 'git:changed' }
