export interface DecisionPayload {
  question: string
  options: Array<{ id: string, label: string }>
  default?: string
}

export type ChangeType = 'added' | 'modified' | 'deleted'

export interface Change {
  path: string
  type: ChangeType
  afterLines?: number
}

export interface ToolCall {
  op: 'write' | 'delete'
  path: string
  size: number
}
export interface SmokePageResult {
  url: string
  ok: boolean
  errors: string[]
}
export interface SmokeResult {
  ran: boolean
  ok: boolean
  pages: SmokePageResult[]
  error?: string
}
export interface ClaimMismatch {
  claimed: string[]
  actual: string[]
  missing: string[]
  extra: string[]
}
export interface BaselineDiffResponse {
  baselineRunId: string
  changes: Change[]
  error?: string
}
export interface RunResponse {
  runId: string
  code: number
  ok: boolean
  error?: string
  scriptDesc?: string
  scriptWhy?: string
  stdout: string
  stderr: string
  changes: Change[]
  lint?: LintResult | null
  test?: { ran: boolean, ok: boolean, stdout: string, stderr: string } | null
  tsc?: { ok: boolean, stdout: string, stderr: string } | null
  /** 失败时服务端从错误输出里提取的项目内文件路径（相对路径） */
  errorFiles?: string[]
  scriptCtx?: string
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

export interface ContextResponse {
  exists: boolean
  content: string
  mtime: number | null
}

export interface RegenerateResponse {
  ok: boolean
  code: number
  stdout: string
  stderr: string
  content: string
  error?: string
}

export interface LintResult {
  ran: boolean
  files: number
  ok: boolean
  stdout: string
  stderr: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

export interface FilesResponse {
  tree: FileNode[]
}

export interface ReadFileResult {
  path: string
  content: string
  error?: string
}

export interface FilesReadResponse {
  files: ReadFileResult[]
}
