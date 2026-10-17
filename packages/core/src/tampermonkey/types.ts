// @ts-nocheck
// [tampermonkey-ts-rewrite-v1] 本文件是 IIFE 的物理切分片段，不是独立模块：
//   跨片段符号（其它片段定义的函数与类型）在单文件 tsc 检查下不可见，
//   且片段内存在顶层 return 等非模块语法。
// [CONSTRAINT] 全部片段 TS 化完成后，按「拼回后的联合视图」统一接线并移除此 pragma——
//   现在移除会让每次增量检查都失败，掩盖真实类型错误。
/**
 * [tampermonkey-ts-rewrite-v1] 油猴脚本 TS 重写版的共享类型。
 * [WHY] 原 .js 片段是 IIFE 内部的物理切分，跨片段共享符号靠「拼回后同作用域」——
 *   TS 无法表达这种语义（加 import/export 就变模块），故本文件只放纯类型声明，
 *   不加 export/import，保持 script 语义；拼回后所有片段都能看到。
 * [CONSTRAINT] 本目录已在 tsconfig.json 的 exclude 中排除：片段无法独立通过 tsc 检查
 *   （引用其它片段的函数、顶层 return 等），类型注解在这里是「文档 + 未来切换脚手架」。
 */

/** 站点会话 ID 提取规则（URL 正则 + 捕获组序号） */
interface SidRule {
  re: RegExp
  n: number
}

/** 工作台 → 油猴：fill 指令 */
interface FillMessage {
  type: 'ai-runner:fill'
  prompt: string
  images?: string[]
  msgId?: string
  ackId?: string
}

/** 工作台 → 油猴：rotate 指令 */
interface RotateMessage {
  type: 'ai-runner:rotate'
  instruction: string
  msgId?: string
}

/** 工作台 → 油猴：new-session 指令 */
interface NewSessionMessage {
  type: 'ai-runner:new-session'
}

/** 工作台 → 油猴：无载荷控制指令 */
type ControlMessage =
  | { type: 'ai-runner:request-replay' }
  | { type: 'ai-runner:request-rescan' }
  | { type: 'ai-runner:stop' }

/** 所有工作台 → 油猴的入站消息 */
type InboundMessage = FillMessage | RotateMessage | NewSessionMessage | ControlMessage

/** 油猴 → 工作台：会话 ID 上报 */
interface SessionIdMessage {
  type: 'ai-runner:session-id'
  id: string
  sessionId: string
  boot?: boolean
}

/** 油猴 → 工作台：回复回传（kind 互斥） */
type ReplyMessage =
  | { type: 'ai-runner:reply'; kind: 'script'; code: string; lang: string; hash: string; site: string; sessionId: string; rescan?: boolean }
  | { type: 'ai-runner:reply'; kind: 'done'; site: string; sessionId: string; text: string }
  | { type: 'ai-runner:reply'; kind: 'plain'; site: string; sessionId: string; text: string; rescan?: boolean }
  | { type: 'ai-runner:reply'; kind: 'stopped'; site: string; sessionId: string; text: string }
  | { type: 'ai-runner:reply'; kind: 'limit'; site: string; sessionId: string; text: string }
  | { type: 'ai-runner:reply'; kind: 'error'; site: string; sessionId: string; text: string }

/** 油猴 → 工作台：fill 回执 */
interface FillAckMessage {
  type: 'ai-runner:fill-ack'
  ok: boolean
  reason: string
  ackId: string
  sid: string
}

/** 油猴 → 工作台：会话 URL 变化 */
interface UrlUpdatedMessage {
  type: 'ai-runner:url-updated'
  url: string
  id: string
}

/** 油猴 → 工作台：新建会话回执 */
interface NewSessionCreatedMessage {
  type: 'ai-runner:new-session-created'
  url: string
  id: string
  sessionId: string
  degraded?: boolean
}

/** 油猴 → 工作台：stop 诊断 */
interface StopDiagMessage {
  type: 'ai-runner:stop-diag'
  count: number
  brief: string
  dsIcon: 'hit' | 'miss' | 'na'
  ver: string
}

/** 所有油猴 → 工作台的外发消息（业务载荷） */
type OutboundMessage =
  | SessionIdMessage
  | ReplyMessage
  | FillAckMessage
  | UrlUpdatedMessage
  | NewSessionCreatedMessage
  | StopDiagMessage

/** 外发消息 + 传输层补齐的字段（msgId/ts 由 post() 注入，调用方不必传） */
type OutboundEnvelope = OutboundMessage & { msgId?: string; ts?: number }
