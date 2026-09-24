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
export type AiReplyKind = 'script' | 'done' | 'plain' | 'multi'

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
  = | { t: 'headless:open', sid: string, url?: string }
    | { t: 'headless:close', sid: string }
    | { t: 'headless:list' }
    | { t: 'headless:fill', sid: string, prompt: string, context?: string }
    | { t: 'headless:stop', sid: string }
    | { t: 'headless:rotate', sid: string, instruction: string }
    | { t: 'headless:new-session', sid: string, summary: string }

/** 服务端 → 客户端消息联合类型 */
export type ServerMessage
  = | { t: 'hello', version: number }
    | { t: 'headless:reply', sid: string, reply: AiReplyDto }
    | { t: 'headless:script', sid: string, item: InboxItemDto }
    | { t: 'headless:state', sid: string, state: TransportState, detail?: string }
    | { t: 'headless:token-estimate', sid: string, tokens: number }
    | { t: 'headless:new-session-created', sid: string, url: string, id: string }
    | { t: 'headless:summary', sid: string, text: string, degraded: boolean }
    | { t: 'headless:list', sessions: unknown[] }
    | { t: 'headless:error', error: string }
