// 共享 wire 类型：Node 侧（index.ts / ws-server.ts）与前端（useAiTransport.ts）共用。
// 只放纯类型，不引入 Vue / DOM 依赖。
// 见 headless-browser-and-core-extract.md §协议。

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

export type AiReplyKind = 'script' | 'done' | 'plain' | 'multi'

export interface AiReplyDto {
  kind: AiReplyKind
  item?: InboxItemDto
  count?: number
  text?: string
}

export interface DecisionOptionDto {
  id: string
  label: string
}

export interface DecisionPayloadDto {
  question: string
  options: DecisionOptionDto[]
  default?: string
}

export interface NeedFilesPayloadDto {
  paths: string[]
}

export type TransportState = 'idle' | 'filling' | 'generating' | 'done' | 'error' | 'rate-limited'

export interface HeadlessStateDto {
  sid: string
  state: TransportState
  detail?: string
}

export interface TransportMessage {
  type: string
  [k: string]: unknown
}
// WS 消息联合类型（ws-server ↔ useAiTransport 共享）

export type ClientMessage
  = | { t: 'headless:open', sid: string, url?: string }
    | { t: 'headless:close', sid: string }
    | { t: 'headless:list' }
    | { t: 'headless:fill', sid: string, prompt: string, context?: string }
    | { t: 'headless:stop', sid: string }
    | { t: 'headless:rotate', sid: string, instruction: string }
    | { t: 'headless:new-session', sid: string, summary: string }

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
