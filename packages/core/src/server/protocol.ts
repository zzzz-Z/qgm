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

// ─────────────────────────────────────────────────────────────────────────────
// [turn-block-frame-v1] turn 信封的块帧（v2.1 契约）
//
// [WHY] 旧契约把一次回复压成一个 `AiReplyDto`（一个 kind + 一个载荷），于是
//   「先说理再跑两个脚本再提问」必须靠前端**再解析文本**还原顺序与归属；
//   `attach-ws.ts` 里 `desc: ''` 那处硬编码就是这个模型的必然产物（没有地方放 desc）。
//   块帧把「顺序」与「载荷」都变成协议字段：一个块一帧，turn 结束一帧。
//
// [CONSTRAINT] 这是**只增**的协议：旧帧（headless:reply / headless:script）一行不改，
//   旧客户端继续走旧帧；新客户端认块帧。双读期至少覆盖到 P8 观察期结束。
// ─────────────────────────────────────────────────────────────────────────────

/** 块类型：与 packages/core/src/reply/turn-schema.ts 的 TURN_BLOCK_TYPES 同源 */
export type AiBlockType = 'say' | 'script' | 'ask' | 'handoff'

/**
 * 一个块。字段按 `type` 收窄（wire 上是 JSON，故用扁平可空字段而非判别联合）。
 * [CONSTRAINT] 不加 `lane` / `parallel` 之类「未来能力」占位：契约只声明已实现的东西，
 *   不支持的能力必须报错，而不是被静默忽略。
 */
export interface AiBlockDto {
  /** 所属 turn；同一轮内唯一，跨轮递增 */
  turnId: number
  /** 块 id（信封里的 id；say 缺省时由解析器补） */
  blockId: string
  /** 在 content 数组中的位置（0 起）。前端按它占位，不按到达顺序 */
  seq: number
  type: AiBlockType
  /** say：正文 */
  text?: string
  /** script：代码正文 */
  code?: string
  /** script：语言（白名单，不做别名归一） */
  lang?: 'js' | 'cjs'
  /** script：做什么（**必须**从块取真值，不允许再由服务端填空串） */
  desc?: string
  /** script：为什么做 */
  why?: string
  /** ask：问题正文 */
  question?: string
  /** ask：选项（直接来自块，前端不再解析文本） */
  options?: DecisionOptionDto[]
  /** handoff：交班摘要 */
  summary?: string
}

/**
 * turn 结束帧：告诉前端「这一轮还有没有后续」。
 * [WHY] 不派生在前端做，是因为它决定**循环是否继续**：awaiting='results' ⇒ 回灌执行结果；
 *   'user' ⇒ 停下来等提问卡；'none' ⇒ 本 turn 即总结，结束循环。
 *   让前端各自从块列表推导，三处（前端 / 服务端 / 油猴）会漂移。
 */
export interface AiTurnEndDto {
  turnId: number
  awaiting: 'results' | 'user' | 'none'
  /** 本轮发出的块数（含被跳过的未知类型不算），用于前端对账「说好的块到齐没有」 */
  blocks: number
  /** 被跳过的块（未知 type 等）——宁可上报也不静默丢弃 */
  skipped?: string[]
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
  = | { t: 'hello', version: number, caps?: string[] }
    | { t: 'headless:reply', sid: string, reply: AiReplyDto, replay?: boolean }
    // [turn-block-frame-v1] 块帧：一个块一帧，按 seq 排序即得原始 content 顺序
    | { t: 'ai:block', sid: string, block: AiBlockDto, replay?: boolean }
    // [turn-block-frame-v1] turn 结束：awaiting 决定循环是否继续（派生规则见 turn-frames.ts）
    | { t: 'ai:turn-end', sid: string, end: AiTurnEndDto, replay?: boolean }
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
