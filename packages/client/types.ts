/** 决策载荷 */
export interface DecisionPayload {
  question: string
  options: Array<{ id: string, label: string }>
  default?: string
}

/** 类型 */
export type ChangeType = 'added' | 'modified' | 'deleted'

/** Change（相关状态/数据） */
export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

/**
 * [cumulative-baseline-v1] 带「归属轮」的变更条目（累积视图专用）
 * [WHY] 累积视图里一条变更可能来自任意历史轮，而 `/__ai/rollback` 只接受「该文件属于该 runId 的
 *   manifest」——所以列表必须自带归属轮，否则回滚会被服务端 400 拒绝。
 * [CONSTRAINT] runId 缺失表示窗口内找不到归属（对应 run 已被 GC），此时 rollbackable 必为 false
 */
export interface ChangeEntry extends Change {
  /** 窗口内**最早**触碰该文件的 run（回滚恢复到该轮运行前 = 基准态） */
  runId?: string
  /** 该归属轮的历史内容是否仍可用（gitRef / .before 之一存在，或类型为 added） */
  rollbackable?: boolean
}

/** toolcall（接口） */
export interface ToolCall {
  op: 'write' | 'delete'
  path: string
  size: number
}
/** 页面 */
export interface SmokePageResult {
  url: string
  ok: boolean
  errors: string[]
}
/** smoke结果（接口） */
export interface SmokeResult {
  ran: boolean
  ok: boolean
  pages: SmokePageResult[]
  error?: string
}
/** claimmismatch（接口） */
export interface ClaimMismatch {
  claimed: string[]
  actual: string[]
  missing: string[]
  extra: string[]
}
/** 差异 */
export interface BaselineDiffResponse {
  baselineRunId: string
  changes: ChangeEntry[]
  error?: string
}
/** 运行 */
export interface RunResponse {
  runId: string
  /** [pipeline-in-summary-v1] 服务端 summary 帧下发的链路状态 */
  pipeline?: Record<string, { status?: string } | undefined>
  code: number
  ok: boolean
  error?: string
  scriptDesc?: string
  scriptWhy?: string
  stdout: string
  stderr: string
  changes: Change[]
  lint?: LintResult | null
  test?: { ran: boolean, ok: boolean, stdout: string, stderr: string, reason?: 'no-test-targets' } | null
  tsc?: { ok: boolean, stdout: string, stderr: string } | null
  /** 失败时服务端从错误输出里提取的项目内文件路径（相对路径） */
  errorFiles?: string[]
  scriptCtx?: string
  /**
   * [truncation-detect-v1] 服务端判定「本轮脚本在尾部被上游截断」
   * [WHY] 截断是输出通道故障，不是 AI 的逻辑失败：反馈文案必须从「重试」改成
   *   「缩小本轮范围、拆成多个小脚本」，否则 AI 会原地重发同样长的脚本再被截断
   * [CONSTRAINT] 仅前置拦截（4xx）时出现；成功轮脚本必然已完整到达
   */
  truncated?: boolean
  /**
   * [truncation-detect-v1] 服务端收到的脚本体积（行/字节）与 §10 预算比对结果
   * [budget-feedback-v1] 前置拦截轮与正常执行轮**都**下发：前者解释「为什么被截断」，
   *   后者供每轮体积配额反馈（AI 无法自行测量输出长度，缺此字段则永远撞墙后才知道墙在哪）
   */
  scriptSize?: { lines: number, bytes: number, overBudget: boolean, maxLines: number, maxBytes: number }
  /**
   * [reject-breaker-v1] 服务端判定「同 sid 同 kind 连续 ≥2 次拒收」已熔断
   * [WHY] 客户端据此 finish(inst, 'breaker-rejected')，避免 AI 无限原地重发
   * [CONSTRAINT] 仅前置拦截（4xx/429）时出现；成功轮必然 undefined
   */
  breaker?: boolean
  /** [L4b] 服务端从错误输出提取的符号指纹，用于连续 2 轮未变检测 */
  fingerprints?: Array<{ file: string, line: number, symbol: string, kind: string }>
  git?: {
    ok: boolean
    commit?: string
    changed: number
    reason?: string
    after?: { ok: boolean, commit?: string, reason?: string } | null
  }
  dryRunFailed?: boolean
  dryRunChangeCount?: number
  dryRunReason?: string
  wantChanges?: Change[]
  tools?: ToolCall[]
  smoke?: SmokeResult | null
  claimMismatch?: ClaimMismatch | null
  /** [P3-2c] 决策点（helpers.cjs exitNeedInput / exit 2） */
  decision?: DecisionPayload | null
  /** [P3-2c] 需要补全的源文件（helpers.cjs exitNeedFiles / exit 4） */
  needFiles?: string[] | null
  /** 本次执行时用到的基准 runId（run() 里在覆盖全局 baseline 之前写入） */
  baselineRunId?: string
  /** [P3-2e] 脚本头 @mode 值；diff = 只读预览模式（不自动 AI 回填） */
  scriptMode?: string
}

/** 上下文 */
export interface ContextResponse {
  exists: boolean
  content: string
  mtime: number | null
}

/** regenerateresponse（接口） */
export interface RegenerateResponse {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  content: string
  error?: string
}

/** lint结果（接口） */
export interface LintResult {
  ran: boolean
  files: number
  ok: boolean
  stdout: string
  stderr: string
}

/** 文件节点 */
export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

/** 文件 */
export interface FilesResponse {
  tree: FileNode[]
}

/** 文件 */
export interface ReadFileResult {
  path: string
  content: string
  error?: string
}

/** 文件 */
export interface FilesReadResponse {
  files: ReadFileResult[]
}
