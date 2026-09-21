// 共享类型

export interface ClaimMismatch {
  claimed: string[]
  actual: string[]
  missing: string[]
  extra: string[]
}

export interface LintResult {
  ran: boolean
  files: number
  ok: boolean
  stdout: string
  stderr: string
}
