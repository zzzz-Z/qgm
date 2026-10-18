// [headless-types-v1] 无头浏览器会话池的共享类型。
// [WHY] ai-headless.ts 超 §4 模块 400 行；类型声明独立后主文件可减 ~60 行。
// [CHANGE-IMPACT] ai-headless.ts 通过 re-export 保持对外 API 兼容。

import type { TransportState } from '../server/protocol.js'
import type { SiteAdapter } from './site-adapters/types.js'

/** 无头浏览器会话：持有浏览器实例、上下文、页面及生命周期钩子 */
export interface HeadlessSession {
  sid: string
  state: TransportState
  detail?: string
  createdAt: number
  url: string
  context?: unknown
  page?: unknown
}

/** 无头浏览器启动配置：目标地址、超时、池大小、请求抖动等 */
export interface HeadlessOptions {
  engine?: 'playwright'
  userDataDir?: string
  defaultUrl?: string
  headless?: boolean
  poolLimit?: number
  queueTimeoutMs?: number
  proxy?: { server: string, username?: string, password?: string }
  humanize?: boolean
  geoip?: boolean
  jitterMin?: number
  jitterMax?: number
  // [site-adapter-v1] 站点适配器；留空时用 getDefaultAdapter()（deepseek 或 AI_SITE_ADAPTER 覆盖）
  adapter?: SiteAdapter
}

/** 无头会话的单次回复：AI 文本、时间戳、是否已结束 */
export interface HeadlessReply {
  // [stopped-detect-v1] stopped = AI 页面「当前问题已停止」（生成被中止，无 DONE/无完整脚本）
  // [limit-detect-v1] limit = AI 会话达到长度上限（继续提问无产出，应触发轮转新会话）
  // [turn-envelope-v1] turn = 页面回复是 JSON 信封，载荷在 blocks；与旧 kind 互斥（解析器优先）
  kind: 'script' | 'done' | 'plain' | 'error' | 'stopped' | 'limit' | 'turn'
  // [turn-envelope-v1] kind='turn' 时有效：所属 turn 与块列表（形状见 reply/turn-frames.ts 的 RawBlock）
  turnId?: number
  blocks?: unknown[]
  /** 信封未闭合（流式）时为 true；服务端据此等待而不发帧 */
  truncated?: boolean
  code?: string
  lang?: string
  hash?: string
  text?: string
  closureRelease?: boolean
  closureTicks?: number
  closureLen?: number
}

/** 无头会话池：管理并发会话与排队，防止资源竞争 */
export interface HeadlessPool {
  open: (sid: string, url?: string) => Promise<HeadlessSession>
  close: (sid: string) => Promise<void>
  get: (sid: string) => HeadlessSession | null
  list: () => HeadlessSession[]
  getPage: (sid: string) => unknown | null
  fillPrompt: (sid: string, prompt: string) => Promise<boolean>
  /** [fill-diagnose-v1] 最近一次 fill 失败原因（not-logged-in / no-input-box / fill 验证失败…）；成功则清空 */
  lastFillError: (sid: string) => string
  stopGenerating: (sid: string) => Promise<boolean>
  newSession: (sid: string) => Promise<{ url: string, id: string } | null>
  /** [headless-login-gui-v1] 引导式登录：有头窗口打开站点，用户登录后关窗，登录态落盘 */
  openLoginGui: (sid: string, url?: string) => Promise<{ ok: boolean, detail?: string }>
  rotate: (sid: string, instruction: string) => Promise<boolean>
  /** 启动回复轮询（每 800ms 扫页面）。返回停止函数。 */
  startReplyPoll: (sid: string, cb: (reply: HeadlessReply) => void) => () => void
  /** 重置轮询 dedup（新一轮对话开始时调用）。 */
  resetReplyDedup: (sid: string) => Promise<void>
}
