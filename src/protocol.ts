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
