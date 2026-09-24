// 共享类型

/** 声明与实际变更不匹配的条目 */
export interface ClaimMismatch {
  claimed: string[]
  actual: string[]
  missing: string[]
  extra: string[]
}

/** lint 结果：是否通过 + 输出摘要 */
export interface LintResult {
  ran: boolean
  files: number
  ok: boolean
  stdout: string
  stderr: string
}
